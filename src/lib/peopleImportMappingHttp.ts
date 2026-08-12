import { parseUtf8CsvWithPhysicalRowNumbers } from './csvParse';
import type { PeopleImportMappingHttpResultCode } from './peopleImportMappingContract';
import {
  PEOPLE_IMPORT_MAPPING_LIMITS,
  inspectPeopleImportMappingSource,
  snapshotPeopleImportMappingContract,
  type PeopleImportMappingContractSnapshot,
  type PeopleImportMappingIssue,
  type PeopleImportMappingTransformResult,
} from './peopleImportMapping';
import {
  PeopleImportMappingConflictError,
  PeopleImportMappingInvalidError,
  PeopleImportMappingPersistenceError,
  PeopleImportMappingStructuralError,
  type PeopleImportMappingProfile,
  type PeopleImportMappingSummary,
} from './peopleImportMappingDb';
import {
  PEOPLE_IMPORT_MULTIPART_MAX_BYTES,
  peopleImportCommitErrorResponse,
  peopleImportJson,
  peopleImportPreviewDto,
  readBoundedCsvMultipart,
  type PeopleImportFileError,
} from './peopleImportHttp';
import type { PeopleImportPreflightResult } from './peopleImportDb';

const MAPPING_CONFIG_MAX_BYTES = 48 * 1024;

export const PEOPLE_IMPORT_MAPPING_MULTIPART_MAX_BYTES =
  PEOPLE_IMPORT_MULTIPART_MAX_BYTES + MAPPING_CONFIG_MAX_BYTES;

export const PEOPLE_IMPORT_MAPPING_SCALAR_FIELDS = [
  'profile_name',
  'mapping_config',
  'profile_id',
  'acknowledge_warnings',
] as const;

export type PeopleImportMappingScalarField =
  (typeof PEOPLE_IMPORT_MAPPING_SCALAR_FIELDS)[number];

type MappingMultipartError = PeopleImportFileError | {
  ok: false;
  status: 413;
  code: Extract<PeopleImportMappingHttpResultCode, 'mapping_config_too_large'>;
};

export type PeopleImportMappingMultipartResult = MappingMultipartError | {
  ok: true;
  bytes: Uint8Array;
  fields: Partial<Record<PeopleImportMappingScalarField, string>>;
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export async function readPeopleImportMappingMultipart(
  request: Request,
  scalarFields: readonly PeopleImportMappingScalarField[],
): Promise<PeopleImportMappingMultipartResult> {
  const upload = await readBoundedCsvMultipart(request, {
    maxBodyBytes: PEOPLE_IMPORT_MAPPING_MULTIPART_MAX_BYTES,
    maxFileBytes: PEOPLE_IMPORT_MAPPING_LIMITS.maxBytes,
  });
  if (!upload.ok) return upload;

  const fields: Partial<Record<PeopleImportMappingScalarField, string>> = {};
  const selectedFields = new Set<PeopleImportMappingScalarField>(scalarFields);
  for (const name of PEOPLE_IMPORT_MAPPING_SCALAR_FIELDS) {
    const values = upload.form.getAll(name);
    if (values.length > 1 || (values.length === 1 && typeof values[0] !== 'string')) {
      return { ok: false, status: 400, code: 'multipart_invalid' };
    }
    if (values.length !== 1) continue;
    const value = values[0] as string;
    if (name === 'mapping_config' && utf8Bytes(value) > MAPPING_CONFIG_MAX_BYTES) {
      return { ok: false, status: 413, code: 'mapping_config_too_large' };
    }
    if (selectedFields.has(name)) fields[name] = value;
  }

  return { ok: true, bytes: upload.bytes, fields };
}

export function mappingProfileId(value: string | undefined): number | null {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

export function mappingAcknowledgesWarnings(value: string | undefined): boolean {
  return value === 'true';
}

function configObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function mappingConfigFromUpload(
  raw: string | undefined,
  expectedHeaders: readonly string[],
): PeopleImportMappingContractSnapshot {
  try {
    if (raw === undefined || utf8Bytes(raw) > MAPPING_CONFIG_MAX_BYTES) throw new TypeError();
    const supplied = configObject(JSON.parse(raw));
    if (supplied === null) throw new TypeError();
    return snapshotPeopleImportMappingContract({
      version: 1,
      expectedHeaders: [...expectedHeaders],
      fieldMappings: supplied.fieldMappings,
      constants: supplied.constants,
      enumTranslations: supplied.enumTranslations,
    });
  } catch {
    return {
      contract: null,
      issues: [{ code: 'invalid_contract', row: null, column: null, field: null }],
    };
  }
}

function issueDto(issue: PeopleImportMappingIssue): PeopleImportMappingIssue {
  return {
    code: issue.code,
    row: issue.row,
    column: issue.column,
    field: issue.field,
  };
}

export function peopleImportMappingInspectDto(bytes: Uint8Array) {
  const inspection = inspectPeopleImportMappingSource(bytes);
  const parsed = parseUtf8CsvWithPhysicalRowNumbers(bytes, PEOPLE_IMPORT_MAPPING_LIMITS);
  return {
    ok: true as const,
    headers: inspection.headers === null ? null : [...inspection.headers],
    headerRowNumber: inspection.headerRowNumber,
    dataRows: parsed.ok ? Math.max(0, parsed.rows.length - 1) : 0,
    issues: inspection.issues.map(issueDto),
  };
}

export function peopleImportMappingSummaryDto(profile: PeopleImportMappingSummary) {
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    createdByPersonId: profile.createdByPersonId,
    createdAt: profile.createdAt,
  };
}

export function peopleImportMappingProfileDto(profile: PeopleImportMappingProfile) {
  return {
    ...peopleImportMappingSummaryDto(profile),
    expectedHeaders: [...profile.expectedHeaders],
    fieldMappings: { ...profile.fieldMappings },
    constants: { ...profile.constants },
    enumTranslations: Object.fromEntries(
      Object.entries(profile.enumTranslations).map(([field, translations]) => [
        field,
        { ...translations },
      ]),
    ),
  };
}

export function peopleImportMappingProfileContract(profile: PeopleImportMappingProfile) {
  return {
    version: 1 as const,
    expectedHeaders: profile.expectedHeaders,
    fieldMappings: profile.fieldMappings,
    constants: profile.constants,
    enumTranslations: profile.enumTranslations,
  };
}

export function peopleImportMappingPreviewResponseDto(
  profile: PeopleImportMappingProfile,
  transformed: PeopleImportMappingTransformResult,
  preflight: PeopleImportPreflightResult = { errors: [], warnings: [] },
) {
  return {
    ok: true as const,
    profile: {
      id: profile.id,
      name: profile.name,
      version: profile.version,
    },
    mappingIssues: transformed.issues.map(issueDto),
    preview: transformed.validation === null
      ? null
      : peopleImportPreviewDto(transformed.validation, preflight),
  };
}

export function peopleImportMappingErrorResponse(error: unknown): Response {
  if (error instanceof PeopleImportMappingInvalidError) {
    return peopleImportJson(400, { ok: false, code: 'mapping_profile_invalid' });
  }
  if (error instanceof PeopleImportMappingConflictError) {
    return peopleImportJson(409, { ok: false, code: 'mapping_profile_conflict' });
  }
  if (error instanceof PeopleImportMappingStructuralError) {
    return peopleImportJson(500, { ok: false, code: 'mapping_profile_corrupt' });
  }
  if (error instanceof PeopleImportMappingPersistenceError) {
    return peopleImportJson(500, { ok: false, code: 'mapping_profile_failed' });
  }
  return peopleImportCommitErrorResponse(error);
}
