import {
  parseUtf8CsvWithPhysicalRowNumbers,
  type CsvParseErrorCode,
} from './csvParse';
import {
  PEOPLE_IMPORT_HEADERS,
  type PeopleImportHeader,
  type PeopleImportValidationResult,
  validatePeopleImportRows,
} from './peopleImport';

export const PEOPLE_IMPORT_MAPPING_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxRows: 201,
  maxColumns: 128,
  maxCellChars: 5_000,
  maxIssues: 100,
});

export type PeopleImportMappingIssueCode =
  | CsvParseErrorCode
  | 'empty_file'
  | 'empty_header'
  | 'duplicate_header'
  | 'header_drift'
  | 'invalid_contract'
  | 'extra_column'
  | 'unknown_enum'
  | 'issues_truncated';

export interface PeopleImportMappingIssue {
  code: PeopleImportMappingIssueCode;
  row: number | null;
  column: number | null;
  field: PeopleImportHeader | null;
}

export interface PeopleImportMappingSourceInspection {
  headers: string[] | null;
  headerRowNumber: number | null;
  issues: PeopleImportMappingIssue[];
}

export const PEOPLE_IMPORT_MAPPING_CONSTANT_FIELDS = Object.freeze([
  'record_type',
  'language',
  'membership_status',
  'active',
  'household_role',
  'household_primary',
] as const satisfies readonly PeopleImportHeader[]);

export const PEOPLE_IMPORT_MAPPING_ENUM_FIELDS = PEOPLE_IMPORT_MAPPING_CONSTANT_FIELDS;

export type PeopleImportMappingConstantField = (typeof PEOPLE_IMPORT_MAPPING_CONSTANT_FIELDS)[number];
export type PeopleImportMappingEnumField = (typeof PEOPLE_IMPORT_MAPPING_ENUM_FIELDS)[number];

export interface PeopleImportMappingContract {
  version: 1;
  expectedHeaders: string[];
  fieldMappings: Record<PeopleImportHeader, number | null>;
  constants: Partial<Record<PeopleImportMappingConstantField, string>>;
  enumTranslations: Partial<Record<PeopleImportMappingEnumField, Record<string, string>>>;
}

export interface PeopleImportMappingContractSnapshot {
  contract: PeopleImportMappingContract | null;
  issues: PeopleImportMappingIssue[];
}

export interface PeopleImportMappingTransformResult {
  rows: string[][] | null;
  rowNumbers: number[] | null;
  validation: PeopleImportValidationResult | null;
  issues: PeopleImportMappingIssue[];
}

const INVALID_SNAPSHOT = Symbol('invalid mapping contract snapshot');
const MAX_CONTRACT_CONTAINER_ENTRIES = PEOPLE_IMPORT_MAPPING_LIMITS.maxColumns;
const CONTRACT_KEYS = ['version', 'expectedHeaders', 'fieldMappings', 'constants', 'enumTranslations'] as const;
const CONSTANT_FIELD_SET = new Set<string>(PEOPLE_IMPORT_MAPPING_CONSTANT_FIELDS);
const ENUM_VALUES: Record<PeopleImportMappingEnumField, ReadonlySet<string>> = {
  record_type: new Set(['person', 'dependent']),
  language: new Set(['en', 'zh']),
  membership_status: new Set(['visitor', 'regular', 'member', 'inactive']),
  active: new Set(['true', 'false']),
  household_role: new Set(['adult', 'child']),
  household_primary: new Set(['true', 'false']),
};

function issue(
  code: PeopleImportMappingIssueCode,
  row: number | null,
  column: number | null,
  field: PeopleImportHeader | null = null,
): PeopleImportMappingIssue {
  return { code, row, column, field };
}

class BoundedMappingIssues {
  private readonly values: PeopleImportMappingIssue[] = [];
  private truncated = false;

  add(value: PeopleImportMappingIssue): void {
    if (this.truncated) return;
    if (this.values.length < PEOPLE_IMPORT_MAPPING_LIMITS.maxIssues) {
      this.values.push(value);
      return;
    }
    this.values[PEOPLE_IMPORT_MAPPING_LIMITS.maxIssues - 1] = issue('issues_truncated', null, null);
    this.truncated = true;
  }

  result(): PeopleImportMappingIssue[] {
    return [...this.values];
  }
}

function normalizeHeader(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function snapshotJson(value: unknown, depth = 0): unknown | typeof INVALID_SNAPSHOT {
  if (depth > 8) return INVALID_SNAPSHOT;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object') return INVALID_SNAPSHOT;

  if (Array.isArray(value)) {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CONTRACT_CONTAINER_ENTRIES) {
      return INVALID_SNAPSHOT;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) return INVALID_SNAPSHOT;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = (descriptors as Record<string, PropertyDescriptor>)['length'];
    if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.value !== length) {
      return INVALID_SNAPSHOT;
    }
    const expectedKeys = Array.from({ length }, (_, index) => String(index));
    const dataKeys = Object.keys(descriptors).filter((key) => key !== 'length');
    if (dataKeys.length !== expectedKeys.length || dataKeys.some((key, index) => key !== expectedKeys[index])) {
      return INVALID_SNAPSHOT;
    }
    const copy: unknown[] = [];
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return INVALID_SNAPSHOT;
      const item = snapshotJson(descriptor.value, depth + 1);
      if (item === INVALID_SNAPSHOT) return INVALID_SNAPSHOT;
      copy.push(item);
    }
    return copy;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) return INVALID_SNAPSHOT;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return INVALID_SNAPSHOT;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length > MAX_CONTRACT_CONTAINER_ENTRIES) return INVALID_SNAPSHOT;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) return INVALID_SNAPSHOT;
    const item = snapshotJson(descriptor.value, depth + 1);
    if (item === INVALID_SNAPSHOT) return INVALID_SNAPSHOT;
    copy[key] = item;
  }
  return copy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function freezeContract(contract: PeopleImportMappingContract): PeopleImportMappingContract {
  Object.freeze(contract.expectedHeaders);
  Object.freeze(contract.fieldMappings);
  Object.freeze(contract.constants);
  for (const translations of Object.values(contract.enumTranslations)) Object.freeze(translations);
  Object.freeze(contract.enumTranslations);
  return Object.freeze(contract);
}

export function snapshotPeopleImportMappingContract(value: unknown): PeopleImportMappingContractSnapshot {
  try {
    const snapshot = snapshotJson(value);
    if (snapshot === INVALID_SNAPSHOT || !isRecord(snapshot) || !hasExactKeys(snapshot, CONTRACT_KEYS)) {
      throw new TypeError('invalid mapping contract');
    }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.expectedHeaders)) {
      throw new TypeError('invalid mapping contract');
    }
    const expectedHeaders = snapshot.expectedHeaders;
    if (expectedHeaders.length < 1 || expectedHeaders.length > PEOPLE_IMPORT_MAPPING_LIMITS.maxColumns) {
      throw new TypeError('invalid mapping contract');
    }
    const expectedSeen = new Set<string>();
    for (const header of expectedHeaders) {
      if (
        typeof header !== 'string'
        || header === ''
        || codePointLength(header) > PEOPLE_IMPORT_MAPPING_LIMITS.maxCellChars
        || normalizeHeader(header) !== header
        || expectedSeen.has(header)
      ) {
        throw new TypeError('invalid mapping contract');
      }
      expectedSeen.add(header);
    }

    if (!isRecord(snapshot.fieldMappings) || !hasExactKeys(snapshot.fieldMappings, PEOPLE_IMPORT_HEADERS)) {
      throw new TypeError('invalid mapping contract');
    }
    const fieldMappings = {} as Record<PeopleImportHeader, number | null>;
    for (const header of PEOPLE_IMPORT_HEADERS) {
      const source = snapshot.fieldMappings[header];
      if (source !== null && (!Number.isSafeInteger(source) || (source as number) < 0 || (source as number) >= expectedHeaders.length)) {
        throw new TypeError('invalid mapping contract');
      }
      fieldMappings[header] = source as number | null;
    }

    if (!isRecord(snapshot.constants)) throw new TypeError('invalid mapping contract');
    const constants: Partial<Record<PeopleImportMappingConstantField, string>> = {};
    for (const [field, constant] of Object.entries(snapshot.constants)) {
      if (!CONSTANT_FIELD_SET.has(field) || typeof constant !== 'string') throw new TypeError('invalid mapping contract');
      const canonicalField = field as PeopleImportMappingConstantField;
      if (fieldMappings[canonicalField] !== null || !ENUM_VALUES[canonicalField].has(constant)) {
        throw new TypeError('invalid mapping contract');
      }
      constants[canonicalField] = constant;
    }

    if (!isRecord(snapshot.enumTranslations)) throw new TypeError('invalid mapping contract');
    const enumTranslations: Partial<Record<PeopleImportMappingEnumField, Record<string, string>>> = {};
    for (const [field, rawTranslations] of Object.entries(snapshot.enumTranslations)) {
      if (!CONSTANT_FIELD_SET.has(field) || !isRecord(rawTranslations)) throw new TypeError('invalid mapping contract');
      const enumField = field as PeopleImportMappingEnumField;
      if (fieldMappings[enumField] === null || Object.keys(rawTranslations).length < 1) {
        throw new TypeError('invalid mapping contract');
      }
      const translations = Object.create(null) as Record<string, string>;
      for (const [source, target] of Object.entries(rawTranslations)) {
        if (
          source === ''
          || codePointLength(source) > PEOPLE_IMPORT_MAPPING_LIMITS.maxCellChars
          || normalizeHeader(source) !== source
          || typeof target !== 'string'
          || !ENUM_VALUES[enumField].has(target)
        ) {
          throw new TypeError('invalid mapping contract');
        }
        translations[source] = target;
      }
      enumTranslations[enumField] = translations;
    }

    return {
      contract: freezeContract({
        version: 1,
        expectedHeaders: [...expectedHeaders] as string[],
        fieldMappings,
        constants,
        enumTranslations,
      }),
      issues: [],
    };
  } catch {
    return {
      contract: null,
      issues: [issue('invalid_contract', null, null)],
    };
  }
}

export function inspectPeopleImportMappingSource(bytes: Uint8Array): PeopleImportMappingSourceInspection {
  const parsed = parseUtf8CsvWithPhysicalRowNumbers(bytes, PEOPLE_IMPORT_MAPPING_LIMITS);
  if (!parsed.ok) {
    return {
      headers: null,
      headerRowNumber: null,
      issues: [issue(parsed.code, parsed.row, parsed.column)],
    };
  }
  if (parsed.rows.length === 0) {
    return {
      headers: null,
      headerRowNumber: null,
      issues: [issue('empty_file', null, null)],
    };
  }

  const headerRowNumber = parsed.rowNumbers[0];
  const headers = parsed.rows[0].map(normalizeHeader);
  const seen = new Set<string>();
  const bounded = new BoundedMappingIssues();
  for (const [index, header] of headers.entries()) {
    if (header === '') {
      bounded.add(issue('empty_header', headerRowNumber, index + 1));
      continue;
    }
    if (seen.has(header)) {
      bounded.add(issue('duplicate_header', headerRowNumber, index + 1));
      continue;
    }
    seen.add(header);
  }
  const issues = bounded.result();

  return {
    headers: issues.length === 0 ? headers : null,
    headerRowNumber,
    issues,
  };
}

function failedTransform(issues: PeopleImportMappingIssue[]): PeopleImportMappingTransformResult {
  return { rows: null, rowNumbers: null, validation: null, issues };
}

function normalizedHeaders(
  cells: string[],
  row: number,
  issues: BoundedMappingIssues,
): string[] {
  const headers = cells.map(normalizeHeader);
  const seen = new Set<string>();
  for (const [index, header] of headers.entries()) {
    if (header === '') {
      issues.add(issue('empty_header', row, index + 1));
      continue;
    }
    if (seen.has(header)) {
      issues.add(issue('duplicate_header', row, index + 1));
      continue;
    }
    seen.add(header);
  }
  return headers;
}

export function transformPeopleImportMapping(
  bytes: Uint8Array,
  runtimeContract: unknown,
  options: { today: string },
): PeopleImportMappingTransformResult {
  const snapped = snapshotPeopleImportMappingContract(runtimeContract);
  if (snapped.contract === null) return failedTransform(snapped.issues);
  const contract = snapped.contract;

  const parsed = parseUtf8CsvWithPhysicalRowNumbers(bytes, PEOPLE_IMPORT_MAPPING_LIMITS);
  if (!parsed.ok) return failedTransform([issue(parsed.code, parsed.row, parsed.column)]);
  if (parsed.rows.length === 0) return failedTransform([issue('empty_file', null, null)]);

  const mappingIssues = new BoundedMappingIssues();
  const headerRow = parsed.rowNumbers[0];
  const headers = normalizedHeaders(parsed.rows[0], headerRow, mappingIssues);
  if (mappingIssues.result().length > 0) return failedTransform(mappingIssues.result());

  const driftColumns = Math.max(headers.length, contract.expectedHeaders.length);
  for (let index = 0; index < driftColumns; index += 1) {
    if (headers[index] !== contract.expectedHeaders[index]) {
      mappingIssues.add(issue('header_drift', headerRow, index + 1));
    }
  }
  if (mappingIssues.result().length > 0) return failedTransform(mappingIssues.result());

  const rows: string[][] = [[...PEOPLE_IMPORT_HEADERS]];
  const rowNumbers = [headerRow];
  const enumFieldSet = new Set<string>(PEOPLE_IMPORT_MAPPING_ENUM_FIELDS);
  for (let rowIndex = 1; rowIndex < parsed.rows.length; rowIndex += 1) {
    const sourceRow = parsed.rows[rowIndex];
    const rowNumber = parsed.rowNumbers[rowIndex];
    for (let columnIndex = headers.length; columnIndex < sourceRow.length; columnIndex += 1) {
      if (sourceRow[columnIndex].trim().normalize('NFC') !== '') {
        mappingIssues.add(issue('extra_column', rowNumber, columnIndex + 1));
      }
    }

    const canonicalRow: string[] = [];
    for (const field of PEOPLE_IMPORT_HEADERS) {
      if (Object.hasOwn(contract.constants, field)) {
        canonicalRow.push(contract.constants[field as PeopleImportMappingConstantField] ?? '');
        continue;
      }
      const sourceIndex = contract.fieldMappings[field];
      if (sourceIndex === null) {
        canonicalRow.push('');
        continue;
      }
      const sourceValue = sourceRow[sourceIndex] ?? '';
      if (!enumFieldSet.has(field)) {
        canonicalRow.push(sourceValue);
        continue;
      }
      const enumField = field as PeopleImportMappingEnumField;
      const normalizedSource = normalizeHeader(sourceValue);
      if (normalizedSource === '') {
        canonicalRow.push('');
        continue;
      }
      const translations = contract.enumTranslations[enumField];
      if (!translations || !Object.hasOwn(translations, normalizedSource)) {
        mappingIssues.add(issue('unknown_enum', rowNumber, sourceIndex + 1, field));
        canonicalRow.push('');
        continue;
      }
      canonicalRow.push(translations[normalizedSource]);
    }
    rows.push(canonicalRow);
    rowNumbers.push(rowNumber);
  }

  const finalIssues = mappingIssues.result();
  if (finalIssues.length > 0) return failedTransform(finalIssues);
  return {
    rows,
    rowNumbers,
    validation: validatePeopleImportRows({ rows, rowNumbers }, options),
    issues: [],
  };
}
