import {
  PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES,
  type PeopleImportMappingHttpResultCode,
} from './peopleImportMappingContract';
import {
  parsePeopleImportCounts,
  parsePeopleImportPreview,
  type PeopleImportUiPreviewPayload,
  type PeopleImportUiSuccessCounts,
} from './peopleImportUi';
import type { PeopleImportHeader } from './peopleImport';
import type { PeopleImportMappingIssueCode } from './peopleImportMapping';

export const PEOPLE_IMPORT_MAPPING_UI_FIELDS = [
  'record_type',
  'display_name',
  'email',
  'first_name',
  'last_name',
  'phone',
  'language',
  'membership_status',
  'birthday',
  'joined_on',
  'address',
  'active',
  'household_key',
  'household_name',
  'household_address',
  'household_phone',
  'household_role',
  'household_primary',
] as const satisfies readonly PeopleImportHeader[];

export const PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS = [
  'record_type',
  'language',
  'membership_status',
  'active',
  'household_role',
  'household_primary',
] as const satisfies readonly PeopleImportHeader[];

export type PeopleImportMappingUiField = (typeof PEOPLE_IMPORT_MAPPING_UI_FIELDS)[number];
export type PeopleImportMappingUiEnumField = (typeof PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS)[number];

export const PEOPLE_IMPORT_MAPPING_UI_ENUM_VALUES = {
  record_type: ['person', 'dependent'],
  language: ['en', 'zh'],
  membership_status: ['visitor', 'regular', 'member', 'inactive'],
  active: ['true', 'false'],
  household_role: ['adult', 'child'],
  household_primary: ['true', 'false'],
} as const satisfies Record<PeopleImportMappingUiEnumField, readonly string[]>;

const FIELD_SET = new Set<string>(PEOPLE_IMPORT_MAPPING_UI_FIELDS);
const ENUM_FIELD_SET = new Set<string>(PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS);
const MAX_PROFILE_NAME_CODE_POINTS = 80;
const MAX_SOURCE_TEXT_CODE_POINTS = 5_000;
export const PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODES = [
  'file_too_large', 'invalid_utf8', 'nul_byte', 'unclosed_quote', 'illegal_quote',
  'lone_cr', 'too_many_rows', 'too_many_columns', 'cell_too_long', 'empty_file',
  'empty_header', 'duplicate_header', 'header_drift', 'invalid_contract',
  'extra_column', 'unknown_enum', 'issues_truncated',
] as const satisfies readonly PeopleImportMappingIssueCode[];

type MissingPeopleImportMappingUiIssueCode = Exclude<
  PeopleImportMappingIssueCode,
  (typeof PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODES)[number]
>;
export const EVERY_PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODE_IS_LISTED:
  MissingPeopleImportMappingUiIssueCode extends never ? true : never = true;

const MAPPING_ISSUE_CODES = new Set<string>(PEOPLE_IMPORT_MAPPING_UI_ISSUE_CODES);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}

function boundedText(value: unknown, maximumCodePoints: number): value is string {
  if (typeof value !== 'string') return false;
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximumCodePoints) return false;
  }
  return true;
}

function nullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed = safeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : undefined;
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

export interface PeopleImportMappingUiIssue {
  code: string;
  row: number | null;
  column: number | null;
  field: PeopleImportMappingUiField | null;
}

function parseMappingIssue(value: unknown): PeopleImportMappingUiIssue | null {
  if (!isObject(value) || !MAPPING_ISSUE_CODES.has(String(value.code))) return null;
  const row = nullablePositiveInteger(value.row);
  const column = nullablePositiveInteger(value.column);
  if (row === undefined || column === undefined) return null;
  if (value.field !== null && (typeof value.field !== 'string' || !FIELD_SET.has(value.field))) return null;
  return {
    code: value.code as string,
    row,
    column,
    field: value.field as PeopleImportMappingUiField | null,
  };
}

function parseMappingIssues(value: unknown): PeopleImportMappingUiIssue[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const issues: PeopleImportMappingUiIssue[] = [];
  for (const candidate of value) {
    const parsed = parseMappingIssue(candidate);
    if (parsed === null) return null;
    issues.push(parsed);
  }
  return issues;
}

export interface PeopleImportMappingInspection {
  headers: string[] | null;
  headerRowNumber: number | null;
  dataRows: number;
  issues: PeopleImportMappingUiIssue[];
}

export function parsePeopleImportMappingInspect(
  status: number,
  value: unknown,
): PeopleImportMappingInspection | null {
  if (status !== 200 || !isObject(value) || value.ok !== true) return null;
  const dataRows = safeInteger(value.dataRows, 200);
  const issues = parseMappingIssues(value.issues);
  if (dataRows === null || issues === null) return null;
  let headers: string[] | null = null;
  if (value.headers !== null) {
    if (!Array.isArray(value.headers) || value.headers.length < 1 || value.headers.length > 128) return null;
    headers = [];
    for (const header of value.headers) {
      if (!boundedText(header, MAX_SOURCE_TEXT_CODE_POINTS) || header === '') return null;
      headers.push(header);
    }
  }
  const headerRowNumber = nullablePositiveInteger(value.headerRowNumber);
  if (headerRowNumber === undefined || (headers === null) !== (headerRowNumber === null)) return null;
  return { headers, headerRowNumber, dataRows, issues };
}

export interface PeopleImportMappingProfileSummary {
  id: number;
  name: string;
  version: 1;
  createdAt: string;
}

export interface PeopleImportMappingUiProfile extends PeopleImportMappingProfileSummary {
  expectedHeaders: string[];
  fieldMappings: Record<PeopleImportMappingUiField, number | null>;
  constants: Partial<Record<PeopleImportMappingUiEnumField, string>>;
  enumTranslations: Partial<Record<PeopleImportMappingUiEnumField, Record<string, string>>>;
}

function parseProfileSummary(value: unknown): PeopleImportMappingProfileSummary | null {
  if (!isObject(value)) return null;
  const id = safeInteger(value.id, 100);
  if (
    id === null || id < 1 || !boundedText(value.name, MAX_PROFILE_NAME_CODE_POINTS) || value.name === ''
    || value.version !== 1
    || typeof value.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value.createdAt)
  ) return null;
  return { id, name: value.name, version: 1, createdAt: value.createdAt };
}

export function parsePeopleImportMappingProfiles(
  status: number,
  value: unknown,
): PeopleImportMappingProfileSummary[] | null {
  if (status !== 200 || !isObject(value) || value.ok !== true || !Array.isArray(value.profiles)) return null;
  if (value.profiles.length > 100) return null;
  const profiles: PeopleImportMappingProfileSummary[] = [];
  for (const candidate of value.profiles) {
    const profile = parseProfileSummary(candidate);
    if (profile === null) return null;
    profiles.push(profile);
  }
  return profiles;
}

function parseExpectedHeaders(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) return null;
  const headers: string[] = [];
  for (const header of value) {
    if (!boundedText(header, MAX_SOURCE_TEXT_CODE_POINTS) || header === '') return null;
    headers.push(header);
  }
  return headers;
}

function parseFieldMappings(
  value: unknown,
  headerCount: number,
): Record<PeopleImportMappingUiField, number | null> | null {
  if (!isObject(value) || !exactKeys(value, PEOPLE_IMPORT_MAPPING_UI_FIELDS)) return null;
  const mappings = {} as Record<PeopleImportMappingUiField, number | null>;
  for (const field of PEOPLE_IMPORT_MAPPING_UI_FIELDS) {
    const source = value[field];
    if (source !== null && (safeInteger(source, headerCount - 1) === null)) return null;
    mappings[field] = source as number | null;
  }
  return mappings;
}

function canonicalEnumValue(field: PeopleImportMappingUiEnumField, value: unknown): value is string {
  return typeof value === 'string'
    && (PEOPLE_IMPORT_MAPPING_UI_ENUM_VALUES[field] as readonly string[]).includes(value);
}

function parseConstants(value: unknown): Partial<Record<PeopleImportMappingUiEnumField, string>> | null {
  if (!isObject(value)) return null;
  const constants: Partial<Record<PeopleImportMappingUiEnumField, string>> = {};
  for (const [field, constant] of Object.entries(value)) {
    if (!ENUM_FIELD_SET.has(field)) return null;
    const enumField = field as PeopleImportMappingUiEnumField;
    if (!canonicalEnumValue(enumField, constant)) return null;
    constants[enumField] = constant;
  }
  return constants;
}

function parseTranslations(
  value: unknown,
): Partial<Record<PeopleImportMappingUiEnumField, Record<string, string>>> | null {
  if (!isObject(value)) return null;
  const translations: Partial<Record<PeopleImportMappingUiEnumField, Record<string, string>>> = {};
  for (const [field, rawTable] of Object.entries(value)) {
    if (!ENUM_FIELD_SET.has(field) || !isObject(rawTable)) return null;
    const enumField = field as PeopleImportMappingUiEnumField;
    const entries = Object.entries(rawTable);
    if (entries.length < 1 || entries.length > 128) return null;
    const table = Object.create(null) as Record<string, string>;
    for (const [source, target] of entries) {
      if (!boundedText(source, MAX_SOURCE_TEXT_CODE_POINTS) || source === '' || !canonicalEnumValue(enumField, target)) {
        return null;
      }
      table[source] = target;
    }
    translations[enumField] = table;
  }
  return translations;
}

export function parsePeopleImportMappingProfile(
  status: number,
  value: unknown,
): PeopleImportMappingUiProfile | null {
  if ((status !== 200 && status !== 201) || !isObject(value) || value.ok !== true || !isObject(value.profile)) {
    return null;
  }
  const summary = parseProfileSummary(value.profile);
  const expectedHeaders = parseExpectedHeaders(value.profile.expectedHeaders);
  if (summary === null || expectedHeaders === null) return null;
  const fieldMappings = parseFieldMappings(value.profile.fieldMappings, expectedHeaders.length);
  const constants = parseConstants(value.profile.constants);
  const enumTranslations = parseTranslations(value.profile.enumTranslations);
  if (fieldMappings === null || constants === null || enumTranslations === null) return null;
  for (const field of PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS) {
    if (fieldMappings[field] !== null && Object.hasOwn(constants, field)) return null;
    if (fieldMappings[field] === null && Object.hasOwn(enumTranslations, field)) return null;
  }
  return { ...summary, expectedHeaders, fieldMappings, constants, enumTranslations };
}

export interface PeopleImportMappingPreviewPayload {
  profile: Pick<PeopleImportMappingProfileSummary, 'id' | 'name' | 'version'>;
  mappingIssues: PeopleImportMappingUiIssue[];
  preview: PeopleImportUiPreviewPayload | null;
}

export function parsePeopleImportMappingPreview(
  status: number,
  value: unknown,
): PeopleImportMappingPreviewPayload | null {
  if (status !== 200 || !isObject(value) || value.ok !== true || !isObject(value.profile)) return null;
  const id = safeInteger(value.profile.id, 100);
  if (
    id === null || id < 1
    || !boundedText(value.profile.name, MAX_PROFILE_NAME_CODE_POINTS)
    || value.profile.name === ''
    || value.profile.version !== 1
  ) return null;
  const mappingIssues = parseMappingIssues(value.mappingIssues);
  if (mappingIssues === null) return null;
  const preview = value.preview === null ? null : parsePeopleImportPreview(200, value.preview);
  if (value.preview !== null && preview === null) return null;
  return {
    profile: { id, name: value.profile.name, version: 1 },
    mappingIssues,
    preview,
  };
}

export function parsePeopleImportMappingCommit(
  status: number,
  value: unknown,
): PeopleImportUiSuccessCounts | null {
  return parsePeopleImportCounts(status, value);
}

export type PeopleImportMappingCommitResponse =
  | { ok: true; counts: PeopleImportUiSuccessCounts }
  | { ok: false; decision: PeopleImportMappingFailureDecision };

export function classifyPeopleImportMappingCommitResponse(
  status: number,
  value: unknown,
): PeopleImportMappingCommitResponse {
  const counts = parsePeopleImportMappingCommit(status, value);
  if (counts !== null) return { ok: true, counts };
  const code = parsePeopleImportMappingResultCode(value);
  return {
    ok: false,
    decision: decidePeopleImportMappingFailure('commit', code, code === null),
  };
}

export function parsePeopleImportMappingResultCode(value: unknown): PeopleImportMappingHttpResultCode | null {
  if (!isObject(value) || typeof value.code !== 'string') return null;
  return PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES.find((code) => code === value.code) ?? null;
}

export interface PeopleImportMappingTranslationRow {
  source: string;
  target: string;
}

export interface PeopleImportMappingDraft {
  expectedHeaders: string[];
  fieldMappings: Record<PeopleImportMappingUiField, number | null>;
  constants: Partial<Record<PeopleImportMappingUiEnumField, string>>;
  translationRows: Partial<Record<PeopleImportMappingUiEnumField, PeopleImportMappingTranslationRow[]>>;
}

export type PeopleImportMappingDraftFieldChoice =
  | { mode: 'empty' }
  | { mode: 'source'; sourceIndex: number }
  | { mode: 'constant'; value: string };

function emptyFieldMappings(): Record<PeopleImportMappingUiField, number | null> {
  return Object.fromEntries(PEOPLE_IMPORT_MAPPING_UI_FIELDS.map((field) => [field, null])) as Record<
    PeopleImportMappingUiField,
    number | null
  >;
}

export function createPeopleImportMappingDraft(expectedHeaders: readonly string[]): PeopleImportMappingDraft {
  return {
    expectedHeaders: [...expectedHeaders],
    fieldMappings: emptyFieldMappings(),
    constants: {},
    translationRows: {},
  };
}

export function updatePeopleImportMappingDraftField(
  draft: PeopleImportMappingDraft,
  field: PeopleImportMappingUiField,
  choice: PeopleImportMappingDraftFieldChoice,
): PeopleImportMappingDraft | null {
  if (!FIELD_SET.has(field)) return null;
  const next = cloneDraft(draft);
  delete next.constants[field as PeopleImportMappingUiEnumField];
  if (choice.mode === 'empty') {
    next.fieldMappings[field] = null;
    delete next.translationRows[field as PeopleImportMappingUiEnumField];
    return next;
  }
  if (choice.mode === 'source') {
    if (!Number.isSafeInteger(choice.sourceIndex) || choice.sourceIndex < 0 || choice.sourceIndex >= draft.expectedHeaders.length) {
      return null;
    }
    next.fieldMappings[field] = choice.sourceIndex;
    return next;
  }
  if (!ENUM_FIELD_SET.has(field)) return null;
  const enumField = field as PeopleImportMappingUiEnumField;
  if (!canonicalEnumValue(enumField, choice.value)) return null;
  next.fieldMappings[field] = null;
  next.constants[enumField] = choice.value;
  delete next.translationRows[enumField];
  return next;
}

function normalizeToken(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

export function updatePeopleImportMappingDraftTranslations(
  draft: PeopleImportMappingDraft,
  field: PeopleImportMappingUiEnumField,
  rows: readonly PeopleImportMappingTranslationRow[],
): PeopleImportMappingDraft | null {
  if (!ENUM_FIELD_SET.has(field) || draft.fieldMappings[field] === null || rows.length > 128) return null;
  const seen = new Set<string>();
  const captured: PeopleImportMappingTranslationRow[] = [];
  for (const row of rows) {
    const source = normalizeToken(row.source);
    if (
      !boundedText(source, MAX_SOURCE_TEXT_CODE_POINTS)
      || source === ''
      || seen.has(source)
      || !canonicalEnumValue(field, row.target)
    ) return null;
    seen.add(source);
    captured.push({ source, target: row.target });
  }
  const next = cloneDraft(draft);
  if (captured.length === 0) delete next.translationRows[field];
  else next.translationRows[field] = captured;
  return next;
}

function cloneDraft(draft: PeopleImportMappingDraft): PeopleImportMappingDraft {
  const translationRows: PeopleImportMappingDraft['translationRows'] = {};
  for (const [field, rows] of Object.entries(draft.translationRows)) {
    translationRows[field as PeopleImportMappingUiEnumField] = rows.map((row) => ({ ...row }));
  }
  return {
    expectedHeaders: [...draft.expectedHeaders],
    fieldMappings: { ...draft.fieldMappings },
    constants: { ...draft.constants },
    translationRows,
  };
}

export function clonePeopleImportMappingDraft(profile: PeopleImportMappingUiProfile): PeopleImportMappingDraft {
  const draft = createPeopleImportMappingDraft(profile.expectedHeaders);
  draft.fieldMappings = { ...profile.fieldMappings };
  draft.constants = { ...profile.constants };
  for (const [field, translations] of Object.entries(profile.enumTranslations)) {
    draft.translationRows[field as PeopleImportMappingUiEnumField] = Object.entries(translations).map(
      ([source, target]) => ({ source, target }),
    );
  }
  return draft;
}

export interface PeopleImportMappingConfigUpload {
  fieldMappings: Record<PeopleImportMappingUiField, number | null>;
  constants: Partial<Record<PeopleImportMappingUiEnumField, string>>;
  enumTranslations: Partial<Record<PeopleImportMappingUiEnumField, Record<string, string>>>;
}

export function mappingDraftConfig(draft: PeopleImportMappingDraft): PeopleImportMappingConfigUpload | null {
  const headers = parseExpectedHeaders(draft.expectedHeaders);
  const fieldMappings = parseFieldMappings(draft.fieldMappings, draft.expectedHeaders.length);
  const constants = parseConstants(draft.constants);
  if (headers === null || fieldMappings === null || constants === null) return null;
  const enumTranslations: PeopleImportMappingConfigUpload['enumTranslations'] = {};
  for (const [field, rows] of Object.entries(draft.translationRows)) {
    if (!ENUM_FIELD_SET.has(field) || !Array.isArray(rows) || rows.length < 1 || rows.length > 128) return null;
    const enumField = field as PeopleImportMappingUiEnumField;
    if (fieldMappings[enumField] === null) return null;
    const table = Object.create(null) as Record<string, string>;
    for (const row of rows) {
      const source = normalizeToken(row.source);
      if (
        !boundedText(source, MAX_SOURCE_TEXT_CODE_POINTS)
        || source === ''
        || Object.hasOwn(table, source)
        || !canonicalEnumValue(enumField, row.target)
      ) return null;
      table[source] = row.target;
    }
    enumTranslations[enumField] = table;
  }
  for (const field of PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS) {
    if (fieldMappings[field] !== null && Object.hasOwn(constants, field)) return null;
  }
  return { fieldMappings: { ...fieldMappings }, constants: { ...constants }, enumTranslations };
}

export type PeopleImportMappingPending = 'inspect' | 'profiles' | 'profile' | 'create' | 'preview' | 'commit';

export interface PeopleImportMappingUiState {
  fileRevision: number;
  profileRevision: number;
  draftRevision: number;
  hasFile: boolean;
  pending: PeopleImportMappingPending | null;
  inspection: PeopleImportMappingInspection | null;
  profiles: PeopleImportMappingProfileSummary[];
  selectedProfile: PeopleImportMappingUiProfile | null;
  draft: PeopleImportMappingDraft | null;
  preview: PeopleImportMappingPreviewPayload | null;
  warningsAcknowledged: boolean;
  success: PeopleImportUiSuccessCounts | null;
}

export interface PeopleImportMappingRequest {
  kind: PeopleImportMappingPending;
  fileRevision: number;
  profileRevision: number;
  draftRevision: number;
}

export interface PeopleImportMappingOperation {
  state: PeopleImportMappingUiState;
  request: PeopleImportMappingRequest;
}

export interface PeopleImportMappingUiControls {
  inspectDisabled: boolean;
  saveDisabled: boolean;
  previewDisabled: boolean;
  commitDisabled: boolean;
  fileDisabled: boolean;
  profileDisabled: boolean;
  draftDisabled: boolean;
}

export function createPeopleImportMappingUiState(): PeopleImportMappingUiState {
  return {
    fileRevision: 0,
    profileRevision: 0,
    draftRevision: 0,
    hasFile: false,
    pending: null,
    inspection: null,
    profiles: [],
    selectedProfile: null,
    draft: null,
    preview: null,
    warningsAcknowledged: false,
    success: null,
  };
}

function clearReview(state: PeopleImportMappingUiState): PeopleImportMappingUiState {
  return { ...state, preview: null, warningsAcknowledged: false, success: null };
}

export function selectPeopleImportMappingFile(
  state: PeopleImportMappingUiState,
  hasFile: boolean,
): PeopleImportMappingUiState {
  if (state.pending === 'commit') return state;
  return {
    ...clearReview(state),
    fileRevision: state.fileRevision + 1,
    draftRevision: state.draftRevision + (state.draft === null ? 0 : 1),
    hasFile,
    pending: null,
    inspection: null,
    draft: null,
  };
}

export function selectPeopleImportMappingProfile(
  state: PeopleImportMappingUiState,
  profile: PeopleImportMappingUiProfile | null,
): PeopleImportMappingUiState {
  if (state.pending === 'commit') return state;
  return {
    ...clearReview(state),
    profileRevision: state.profileRevision + 1,
    draftRevision: state.draftRevision + (state.draft === null ? 0 : 1),
    pending: null,
    selectedProfile: profile,
    draft: null,
  };
}

export function editPeopleImportMappingDraft(
  state: PeopleImportMappingUiState,
  draft: PeopleImportMappingDraft,
): PeopleImportMappingUiState {
  if (state.pending === 'commit') return state;
  return {
    ...clearReview(state),
    profileRevision: state.profileRevision + (state.selectedProfile === null ? 0 : 1),
    draftRevision: state.draftRevision + 1,
    pending: null,
    selectedProfile: null,
    draft: cloneDraft(draft),
  };
}

function previewHasErrors(preview: PeopleImportMappingPreviewPayload | null): boolean {
  return preview === null
    || preview.mappingIssues.length > 0
    || preview.preview === null
    || preview.preview.issues.some((issue) => issue.severity === 'error');
}

function previewHasWarnings(preview: PeopleImportMappingPreviewPayload | null): boolean {
  return preview?.preview?.issues.some((issue) => issue.severity === 'warning') ?? false;
}

export function peopleImportMappingUiControls(state: PeopleImportMappingUiState): PeopleImportMappingUiControls {
  const commitPending = state.pending === 'commit';
  const busy = state.pending !== null;
  const inspected = state.inspection?.headers !== null && state.inspection?.headers !== undefined;
  return {
    inspectDisabled: !state.hasFile || busy,
    saveDisabled: busy || !state.hasFile || !inspected || state.draft === null || mappingDraftConfig(state.draft) === null,
    previewDisabled: busy || !state.hasFile || !inspected || state.selectedProfile === null,
    commitDisabled:
      busy || previewHasErrors(state.preview)
      || (previewHasWarnings(state.preview) && state.warningsAcknowledged !== true),
    fileDisabled: commitPending,
    profileDisabled: commitPending,
    draftDisabled: commitPending,
  };
}

export function beginPeopleImportMappingRequest(
  state: PeopleImportMappingUiState,
  kind: PeopleImportMappingPending,
): PeopleImportMappingOperation | null {
  const controls = peopleImportMappingUiControls(state);
  if (
    (kind === 'inspect' && controls.inspectDisabled)
    || (kind === 'create' && controls.saveDisabled)
    || (kind === 'preview' && controls.previewDisabled)
    || (kind === 'commit' && controls.commitDisabled)
    || (state.pending !== null)
  ) return null;
  const request: PeopleImportMappingRequest = {
    kind,
    fileRevision: state.fileRevision,
    profileRevision: state.profileRevision,
    draftRevision: state.draftRevision,
  };
  return {
    request,
    state: {
      ...state,
      pending: kind,
      ...(kind === 'preview' ? { preview: null, warningsAcknowledged: false } : {}),
    },
  };
}

function activeRequest(state: PeopleImportMappingUiState, request: PeopleImportMappingRequest): boolean {
  return state.pending === request.kind
    && state.fileRevision === request.fileRevision
    && state.profileRevision === request.profileRevision
    && state.draftRevision === request.draftRevision;
}

export function applyPeopleImportMappingInspect(
  state: PeopleImportMappingUiState,
  request: PeopleImportMappingRequest,
  inspection: PeopleImportMappingInspection,
): PeopleImportMappingUiState {
  if (request.kind !== 'inspect' || !activeRequest(state, request)) return state;
  return { ...state, pending: null, inspection, preview: null, warningsAcknowledged: false };
}

export function applyPeopleImportMappingProfiles(
  state: PeopleImportMappingUiState,
  request: PeopleImportMappingRequest,
  profiles: PeopleImportMappingProfileSummary[],
): PeopleImportMappingUiState {
  if (request.kind !== 'profiles' || !activeRequest(state, request)) return state;
  return { ...state, pending: null, profiles: profiles.map((profile) => ({ ...profile })) };
}

export function applyPeopleImportMappingProfile(
  state: PeopleImportMappingUiState,
  request: PeopleImportMappingRequest,
  profile: PeopleImportMappingUiProfile,
): PeopleImportMappingUiState {
  if ((request.kind !== 'profile' && request.kind !== 'create') || !activeRequest(state, request)) return state;
  return {
    ...state,
    pending: null,
    selectedProfile: profile,
    draft: null,
    preview: null,
    warningsAcknowledged: false,
    profiles: state.profiles.some((item) => item.id === profile.id)
      ? state.profiles
      : [...state.profiles, profile],
  };
}

export function applyPeopleImportMappingPreview(
  state: PeopleImportMappingUiState,
  request: PeopleImportMappingRequest,
  preview: PeopleImportMappingPreviewPayload,
): PeopleImportMappingUiState {
  if (request.kind !== 'preview' || !activeRequest(state, request)) return state;
  return { ...state, pending: null, preview, warningsAcknowledged: false, success: null };
}

export function setPeopleImportMappingWarningAcknowledgement(
  state: PeopleImportMappingUiState,
  acknowledged: unknown,
): PeopleImportMappingUiState {
  if (state.pending !== null || state.preview === null || state.success !== null) return state;
  return { ...state, warningsAcknowledged: acknowledged === true };
}

export function applyPeopleImportMappingCommit(
  state: PeopleImportMappingUiState,
  request: PeopleImportMappingRequest,
  success: PeopleImportUiSuccessCounts,
): PeopleImportMappingUiState {
  if (request.kind !== 'commit' || !activeRequest(state, request)) return state;
  return {
    ...state,
    pending: null,
    preview: null,
    warningsAcknowledged: false,
    success: { ...success },
  };
}

export interface PeopleImportMappingFailureDecision {
  messageKey: string;
  clearPreview: boolean;
  clearProfile: boolean;
  checkPeople: boolean;
}

export function decidePeopleImportMappingFailure(
  kind: PeopleImportMappingPending,
  code: PeopleImportMappingHttpResultCode | null,
  uncertain: boolean,
): PeopleImportMappingFailureDecision {
  if (kind === 'commit' && uncertain) {
    return {
      messageKey: 'admin.peopleImportMapping.failure.uncertainCommit',
      clearPreview: true,
      clearProfile: false,
      checkPeople: true,
    };
  }
  if (code === 'mapping_profile_not_found' || code === 'mapping_profile_corrupt') {
    return {
      messageKey: `admin.peopleImportMapping.result.${code}`,
      clearPreview: true,
      clearProfile: true,
      checkPeople: false,
    };
  }
  const fresh = kind === 'commit'
    && (code === 'import_conflict' || code === 'warnings_not_acknowledged' || code === 'validation_failed');
  return {
    messageKey: code === null
      ? uncertain
        ? 'admin.peopleImportMapping.failure.network'
        : 'admin.peopleImportMapping.failure.unexpected'
      : `admin.peopleImportMapping.result.${code}`,
    clearPreview: fresh || kind === 'preview',
    clearProfile: false,
    checkPeople: kind === 'commit' && code === 'import_conflict',
  };
}

export function rejectPeopleImportMappingRequest(
  state: PeopleImportMappingUiState,
  request: PeopleImportMappingRequest,
  decision: PeopleImportMappingFailureDecision,
): PeopleImportMappingUiState {
  if (!activeRequest(state, request)) return state;
  return {
    ...state,
    pending: null,
    preview: decision.clearPreview ? null : state.preview,
    warningsAcknowledged: decision.clearPreview ? false : state.warningsAcknowledged,
    selectedProfile: decision.clearProfile ? null : state.selectedProfile,
  };
}
