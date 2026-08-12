import type { AppDb } from './appDb';
import { isValidDateStr } from './dates';
import {
  PEOPLE_IMPORT_MAPPING_LIMITS,
  snapshotPeopleImportMappingContract,
  type PeopleImportMappingContract,
} from './peopleImportMapping';

export const PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS = {
  maxProfiles: 100,
  maxNameCodePoints: 80,
  maxHeaders: PEOPLE_IMPORT_MAPPING_LIMITS.maxColumns,
  maxHeaderCodePoints: PEOPLE_IMPORT_MAPPING_LIMITS.maxCellChars,
  maxExpectedHeadersJsonChars: 65_536,
  maxFieldMappingsJsonChars: 8_192,
  maxConstantsJsonChars: 4_096,
  maxEnumTranslationsJsonChars: 65_536,
} as const;

export interface CreatePeopleImportMappingInput {
  name: string;
  expectedHeaders: PeopleImportMappingContract['expectedHeaders'];
  fieldMappings: PeopleImportMappingContract['fieldMappings'];
  constants: PeopleImportMappingContract['constants'];
  enumTranslations: PeopleImportMappingContract['enumTranslations'];
  createdByPersonId: number;
}

export interface PeopleImportMappingProfile {
  id: number;
  name: string;
  nameKey: string;
  version: 1;
  expectedHeaders: PeopleImportMappingContract['expectedHeaders'];
  fieldMappings: PeopleImportMappingContract['fieldMappings'];
  constants: PeopleImportMappingContract['constants'];
  enumTranslations: PeopleImportMappingContract['enumTranslations'];
  createdByPersonId: number;
  createdAt: string;
}

export type PeopleImportMappingSummary = Pick<
  PeopleImportMappingProfile,
  'id' | 'name' | 'version' | 'createdByPersonId' | 'createdAt'
>;

export class PeopleImportMappingInvalidError extends Error {
  readonly code = 'mapping_profile_invalid' as const;

  constructor() {
    super('Mapping profile is invalid');
    this.name = 'PeopleImportMappingInvalidError';
  }
}

export class PeopleImportMappingConflictError extends Error {
  readonly code = 'mapping_profile_conflict' as const;

  constructor() {
    super('Mapping profile conflicts');
    this.name = 'PeopleImportMappingConflictError';
  }
}

export class PeopleImportMappingStructuralError extends Error {
  readonly code = 'mapping_profile_corrupt' as const;

  constructor() {
    super('Mapping profile data is corrupt');
    this.name = 'PeopleImportMappingStructuralError';
  }
}

export class PeopleImportMappingPersistenceError extends Error {
  readonly code = 'mapping_profile_failed' as const;

  constructor() {
    super('Mapping profile operation failed');
    this.name = 'PeopleImportMappingPersistenceError';
  }
}

type DbRow = Record<string, unknown>;
type SnapshottedInput = {
  name: string;
  nameKey: string;
  contract: PeopleImportMappingContract;
  createdByPersonId: number;
  json: {
    expectedHeaders: string;
    fieldMappings: string;
    constants: string;
    enumTranslations: string;
  };
};

const INPUT_KEYS = [
  'name',
  'expectedHeaders',
  'fieldMappings',
  'constants',
  'enumTranslations',
  'createdByPersonId',
] as const;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function identity(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFC');
}

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
    const keys = Array.from({ length: value.length }, (_, index) => String(index));
    if (
      Object.keys(descriptors).length !== keys.length + 1
      || keys.some((key) => !Object.hasOwn(descriptors, key))
    ) return false;
    return keys.every((key) => {
      const descriptor = descriptors[key];
      return descriptor !== undefined
        && Object.hasOwn(descriptor, 'value')
        && descriptor.get === undefined
        && descriptor.set === undefined
        && isPlainDataGraph(descriptor.value, seen);
    });
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => (
    Object.hasOwn(descriptor, 'value')
    && descriptor.get === undefined
    && descriptor.set === undefined
    && isPlainDataGraph(descriptor.value, seen)
  ));
}

function clonePlainData(value: unknown): unknown | null {
  try {
    if (!isPlainDataGraph(value, new Set())) return null;
    return structuredClone(value);
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function boundedJson(value: unknown, maximum: number): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && json.length >= 2 && json.length <= maximum ? json : null;
  } catch {
    return null;
  }
}

function snapshotInput(input: unknown): SnapshottedInput | null {
  const cloned = clonePlainData(input);
  if (!isPlainRecord(cloned) || !hasExactKeys(cloned, INPUT_KEYS)) return null;

  const rawName = cloned.name;
  const createdByPersonId = cloned.createdByPersonId;
  if (
    typeof rawName !== 'string'
    || !Number.isSafeInteger(createdByPersonId)
    || (createdByPersonId as number) <= 0
  ) return null;

  const name = normalizedName(rawName);
  if (name === '' || codePoints(name) > PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxNameCodePoints) return null;
  const nameKey = identity(name);
  if (nameKey === '' || codePoints(nameKey) > PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxNameCodePoints) return null;

  const contractSnapshot = snapshotPeopleImportMappingContract({
    version: 1,
    expectedHeaders: cloned.expectedHeaders,
    fieldMappings: cloned.fieldMappings,
    constants: cloned.constants,
    enumTranslations: cloned.enumTranslations,
  });
  if (contractSnapshot.contract === null) return null;
  const contract = contractSnapshot.contract;

  const json = {
    expectedHeaders: boundedJson(
      contract.expectedHeaders,
      PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxExpectedHeadersJsonChars,
    ),
    fieldMappings: boundedJson(
      contract.fieldMappings,
      PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxFieldMappingsJsonChars,
    ),
    constants: boundedJson(
      contract.constants,
      PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxConstantsJsonChars,
    ),
    enumTranslations: boundedJson(
      contract.enumTranslations,
      PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxEnumTranslationsJsonChars,
    ),
  };
  if (Object.values(json).some((value) => value === null)) return null;

  return {
    name,
    nameKey,
    contract,
    createdByPersonId: createdByPersonId as number,
    json: json as SnapshottedInput['json'],
  };
}

function isSqlTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4}-\d{2}-\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.exec(value);
  return match !== null && isValidDateStr(match[1]);
}

function parseJson(text: unknown, maximum: number): unknown | null {
  if (typeof text !== 'string' || text.length < 2 || text.length > maximum) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function profileFromRow(row: unknown): PeopleImportMappingProfile {
  try {
    if (!isPlainRecord(row)) throw new PeopleImportMappingStructuralError();
    const id = row.id;
    const name = row.name;
    const nameKey = row.name_key;
    const version = row.version;
    const createdByPersonId = row.created_by_person_id;
    const createdAt = row.created_at;
    if (
      !Number.isSafeInteger(id)
      || (id as number) < 1
      || (id as number) > PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxProfiles
      || typeof name !== 'string'
      || typeof nameKey !== 'string'
      || version !== 1
      || !Number.isSafeInteger(createdByPersonId)
      || (createdByPersonId as number) <= 0
      || !isSqlTimestamp(createdAt)
    ) throw new PeopleImportMappingStructuralError();

    const candidate = snapshotInput({
      name,
      expectedHeaders: parseJson(
        row.expected_headers_json,
        PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxExpectedHeadersJsonChars,
      ),
      fieldMappings: parseJson(
        row.field_mappings_json,
        PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxFieldMappingsJsonChars,
      ),
      constants: parseJson(
        row.constants_json,
        PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxConstantsJsonChars,
      ),
      enumTranslations: parseJson(
        row.enum_translations_json,
        PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxEnumTranslationsJsonChars,
      ),
      createdByPersonId,
    });
    if (candidate === null || candidate.name !== name || candidate.nameKey !== nameKey) {
      throw new PeopleImportMappingStructuralError();
    }
    return {
      id: id as number,
      name: candidate.name,
      nameKey: candidate.nameKey,
      version: 1,
      expectedHeaders: candidate.contract.expectedHeaders,
      fieldMappings: candidate.contract.fieldMappings,
      constants: candidate.contract.constants,
      enumTranslations: candidate.contract.enumTranslations,
      createdByPersonId: candidate.createdByPersonId,
      createdAt,
    };
  } catch (error) {
    if (error instanceof PeopleImportMappingStructuralError) throw error;
    throw new PeopleImportMappingStructuralError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  try {
    return String(error).includes('UNIQUE constraint failed')
      || String(error).includes('duplicate key value violates unique constraint')
      || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505');
  } catch {
    return false;
  }
}

const PROFILE_COLUMNS = `id, name, name_key, version, expected_headers_json,
  field_mappings_json, constants_json, enum_translations_json,
  created_by_person_id, created_at`;

const CREATE_SQL = `
  INSERT INTO people_import_mappings
    (id, name, name_key, expected_headers_json, field_mappings_json,
     constants_json, enum_translations_json, created_by_person_id)
  SELECT COALESCE(MAX(id), 0) + 1, ?1, ?2, ?3, ?4, ?5, ?6, ?7
  FROM people_import_mappings
  HAVING COUNT(*) < 100 AND COALESCE(MAX(id), 0) + 1 <= 100
  RETURNING ${PROFILE_COLUMNS}
`;

export async function createPeopleImportMapping(
  db: AppDb,
  input: CreatePeopleImportMappingInput,
): Promise<PeopleImportMappingProfile> {
  const captured = snapshotInput(input);
  if (captured === null) throw new PeopleImportMappingInvalidError();
  try {
    const row = await db.prepare(CREATE_SQL).bind(
      captured.name,
      captured.nameKey,
      captured.json.expectedHeaders,
      captured.json.fieldMappings,
      captured.json.constants,
      captured.json.enumTranslations,
      captured.createdByPersonId,
    ).first<DbRow>();
    if (row === null) throw new PeopleImportMappingConflictError();
    return profileFromRow(row);
  } catch (error) {
    if (
      error instanceof PeopleImportMappingConflictError
      || error instanceof PeopleImportMappingStructuralError
    ) throw error;
    if (isUniqueViolation(error)) throw new PeopleImportMappingConflictError();
    throw new PeopleImportMappingPersistenceError();
  }
}

export async function getPeopleImportMapping(
  db: AppDb,
  id: number,
): Promise<PeopleImportMappingProfile | null> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new PeopleImportMappingInvalidError();
  try {
    const row = await db.prepare(`
      SELECT ${PROFILE_COLUMNS}
      FROM people_import_mappings
      WHERE id = ?
    `).bind(id).first<DbRow>();
    return row === null ? null : profileFromRow(row);
  } catch (error) {
    if (error instanceof PeopleImportMappingStructuralError) throw error;
    throw new PeopleImportMappingPersistenceError();
  }
}

export async function listPeopleImportMappings(db: AppDb): Promise<PeopleImportMappingSummary[]> {
  try {
    const { results } = await db.prepare(`
      SELECT ${PROFILE_COLUMNS}
      FROM people_import_mappings
      ORDER BY name_key, id
      LIMIT 101
    `).all<DbRow>();
    if (results.length > PEOPLE_IMPORT_MAPPING_PROFILE_LIMITS.maxProfiles) {
      throw new PeopleImportMappingStructuralError();
    }
    return results.map((row) => {
      const profile = profileFromRow(row);
      return {
        id: profile.id,
        name: profile.name,
        version: profile.version,
        createdByPersonId: profile.createdByPersonId,
        createdAt: profile.createdAt,
      };
    });
  } catch (error) {
    if (error instanceof PeopleImportMappingStructuralError) throw error;
    throw new PeopleImportMappingPersistenceError();
  }
}
