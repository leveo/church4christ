import {
  PEOPLE_IMPORT_HTTP_RESULT_CODES,
  type PeopleImportHttpResultCode,
} from './peopleImportContract';

export interface PeopleImportUiSummary {
  dataRows: number;
  people: number;
  dependents: number;
  households: number;
  inactivePeople: number;
}

export interface PeopleImportUiSuccessCounts {
  people: number;
  households: number;
  dependents: number;
}

export interface PeopleImportUiIssue {
  severity: 'error' | 'warning';
}

export interface PeopleImportUiPreviewIssue extends PeopleImportUiIssue {
  code: string;
  row: number | null;
  field: string | null;
}

export interface PeopleImportUiPreviewRow {
  row: number;
  recordType: string;
  displayName: string;
  email: string;
  householdName: string;
}

export interface PeopleImportUiPreviewPayload {
  summary: PeopleImportUiSummary;
  rows: PeopleImportUiPreviewRow[];
  issues: PeopleImportUiPreviewIssue[];
}

export interface PeopleImportUiPreview {
  summary: PeopleImportUiSummary;
  issues: readonly PeopleImportUiIssue[];
}

export type PeopleImportUiFailure = 'generic' | 'network' | 'import_conflict';
export type PeopleImportUiPending = 'preview' | 'commit';

export interface PeopleImportUiState {
  fileRevision: number;
  hasFile: boolean;
  pending: PeopleImportUiPending | null;
  preview: PeopleImportUiPreview | null;
  warningsAcknowledged: boolean;
  failure: PeopleImportUiFailure | null;
  success: PeopleImportUiSuccessCounts | null;
}

export interface PeopleImportUiRequest {
  kind: PeopleImportUiPending;
  fileRevision: number;
}

export interface PeopleImportUiOperation {
  state: PeopleImportUiState;
  request: PeopleImportUiRequest;
}

export interface PeopleImportUiControls {
  previewDisabled: boolean;
  commitDisabled: boolean;
  fileDisabled: boolean;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parsePeopleImportSummary(value: unknown): PeopleImportUiSummary | null {
  if (!isObject(value)) return null;
  const dataRows = safeCount(value.dataRows);
  const people = safeCount(value.people);
  const dependents = safeCount(value.dependents);
  const households = safeCount(value.households);
  const inactivePeople = safeCount(value.inactivePeople);
  if (
    dataRows === null || people === null || dependents === null ||
    households === null || inactivePeople === null
  ) {
    return null;
  }
  return {
    dataRows,
    people,
    dependents,
    households,
    inactivePeople,
  };
}

export function parsePeopleImportPreview(
  status: number,
  value: unknown,
): PeopleImportUiPreviewPayload | null {
  if (
    status !== 200 || !isObject(value) || value.ok !== true ||
    !Array.isArray(value.rows) || !Array.isArray(value.issues)
  ) return null;

  const summary = parsePeopleImportSummary(value.summary);
  if (summary === null) return null;

  const rows: PeopleImportUiPreviewRow[] = [];
  for (const candidate of value.rows) {
    if (
      !isObject(candidate) || typeof candidate.recordType !== 'string' ||
      typeof candidate.displayName !== 'string'
    ) return null;
    const row = safeCount(candidate.row);
    if (row === null) return null;
    if (candidate.email !== undefined && typeof candidate.email !== 'string') return null;
    if (candidate.household !== null && candidate.household !== undefined && !isObject(candidate.household)) {
      return null;
    }
    const household = isObject(candidate.household) ? candidate.household : null;
    let householdName = '';
    if (household !== null) {
      if (typeof household.name !== 'string') return null;
      householdName = household.name;
    }
    rows.push({
      row,
      recordType: candidate.recordType,
      displayName: candidate.displayName,
      email: typeof candidate.email === 'string' ? candidate.email : '',
      householdName,
    });
  }

  const issues: PeopleImportUiPreviewIssue[] = [];
  for (const candidate of value.issues) {
    if (
      !isObject(candidate) || (candidate.severity !== 'error' && candidate.severity !== 'warning') ||
      typeof candidate.code !== 'string'
    ) return null;
    const row = candidate.row === null ? null : safeCount(candidate.row);
    if (row === null && candidate.row !== null) return null;
    if (candidate.field !== null && typeof candidate.field !== 'string') return null;
    issues.push({
      severity: candidate.severity,
      code: candidate.code,
      row,
      field: candidate.field,
    });
  }
  return { summary, rows, issues };
}

export function parsePeopleImportCounts(
  status: number,
  value: unknown,
): PeopleImportUiSuccessCounts | null {
  if (status !== 201 || !isObject(value) || value.ok !== true || !isObject(value.counts)) return null;
  const people = safeCount(value.counts.people);
  const households = safeCount(value.counts.households);
  const dependents = safeCount(value.counts.dependents);
  return people === null || households === null || dependents === null
    ? null
    : { people, households, dependents };
}

export function parsePeopleImportResultCode(value: unknown): PeopleImportHttpResultCode | null {
  if (!isObject(value) || typeof value.code !== 'string') return null;
  return PEOPLE_IMPORT_HTTP_RESULT_CODES.find((code) => code === value.code) ?? null;
}

export type PeopleImportFailureMessageKey =
  | 'admin.peopleImport.repreviewRequired'
  | 'admin.peopleImport.genericError'
  | 'admin.peopleImport.networkError'
  | 'admin.peopleImport.previewError'
  | `admin.peopleImport.result.${PeopleImportHttpResultCode}`;

export interface PeopleImportFailureDecision {
  failure: PeopleImportUiFailure;
  messageKey: PeopleImportFailureMessageKey;
  requiresFreshPreview: boolean;
}

export function decidePeopleImportFailure(
  kind: PeopleImportUiPending,
  code: PeopleImportHttpResultCode | null,
  requestWasUncertain: boolean,
): PeopleImportFailureDecision {
  const failure: PeopleImportUiFailure = code === 'import_conflict'
    ? 'import_conflict'
    : requestWasUncertain ? 'network' : 'generic';

  if (code === 'import_conflict' || code === 'warnings_not_acknowledged') {
    return {
      failure,
      messageKey: 'admin.peopleImport.repreviewRequired',
      requiresFreshPreview: kind === 'commit',
    };
  }
  if (code === null) {
    return {
      failure,
      messageKey: kind === 'commit'
        ? 'admin.peopleImport.genericError'
        : requestWasUncertain
          ? 'admin.peopleImport.networkError'
          : 'admin.peopleImport.previewError',
      requiresFreshPreview: kind === 'commit',
    };
  }
  if (code === 'generic_error') {
    return {
      failure,
      messageKey: kind === 'commit'
        ? 'admin.peopleImport.genericError'
        : 'admin.peopleImport.previewError',
      requiresFreshPreview: kind === 'commit',
    };
  }
  return {
    failure,
    messageKey: `admin.peopleImport.result.${code}`,
    requiresFreshPreview: kind === 'commit' && code === 'validation_failed',
  };
}

export function createPeopleImportUiState(): PeopleImportUiState {
  return {
    fileRevision: 0,
    hasFile: false,
    pending: null,
    preview: null,
    warningsAcknowledged: false,
    failure: null,
    success: null,
  };
}

export function selectPeopleImportFile(state: PeopleImportUiState, hasFile: boolean): PeopleImportUiState {
  return {
    ...createPeopleImportUiState(),
    fileRevision: state.fileRevision + 1,
    hasFile,
  };
}

function issueCount(state: PeopleImportUiState, severity: PeopleImportUiIssue['severity']): number {
  return state.preview?.issues.filter((issue) => issue.severity === severity).length ?? 0;
}

export function peopleImportUiControls(state: PeopleImportUiState): PeopleImportUiControls {
  const pendingOrComplete = state.pending !== null || state.success !== null;
  const hasErrors = issueCount(state, 'error') > 0;
  const hasUnacknowledgedWarnings = issueCount(state, 'warning') > 0 && state.warningsAcknowledged !== true;

  return {
    previewDisabled: !state.hasFile || pendingOrComplete,
    commitDisabled:
      pendingOrComplete || state.preview === null || hasErrors || hasUnacknowledgedWarnings,
    fileDisabled: state.pending === 'commit',
  };
}

export function beginPeopleImportPreview(state: PeopleImportUiState): PeopleImportUiOperation | null {
  if (peopleImportUiControls(state).previewDisabled) return null;

  const request: PeopleImportUiRequest = { kind: 'preview', fileRevision: state.fileRevision };
  return {
    request,
    state: {
      ...state,
      pending: 'preview',
      preview: null,
      warningsAcknowledged: false,
      failure: null,
      success: null,
    },
  };
}

export function beginPeopleImportCommit(state: PeopleImportUiState): PeopleImportUiOperation | null {
  if (peopleImportUiControls(state).commitDisabled) return null;

  const request: PeopleImportUiRequest = { kind: 'commit', fileRevision: state.fileRevision };
  return {
    request,
    state: { ...state, pending: 'commit', failure: null },
  };
}

function isActiveRequest(state: PeopleImportUiState, request: PeopleImportUiRequest): boolean {
  return state.pending === request.kind && state.fileRevision === request.fileRevision;
}

export function applyPeopleImportPreview(
  state: PeopleImportUiState,
  request: PeopleImportUiRequest,
  preview: PeopleImportUiPreview,
): PeopleImportUiState {
  if (request.kind !== 'preview' || !isActiveRequest(state, request)) return state;

  return {
    ...state,
    pending: null,
    preview: {
      summary: { ...preview.summary },
      issues: [...preview.issues],
    },
    warningsAcknowledged: false,
    failure: null,
    success: null,
  };
}

export function setPeopleImportWarningsAcknowledged(
  state: PeopleImportUiState,
  acknowledged: unknown,
): PeopleImportUiState {
  if (state.preview === null || state.pending !== null || state.success !== null) return state;
  return { ...state, warningsAcknowledged: acknowledged === true };
}

export function applyPeopleImportCommit(
  state: PeopleImportUiState,
  request: PeopleImportUiRequest,
  counts: PeopleImportUiSuccessCounts,
): PeopleImportUiState {
  if (request.kind !== 'commit' || !isActiveRequest(state, request)) return state;

  return {
    ...state,
    pending: null,
    preview: null,
    warningsAcknowledged: false,
    failure: null,
    success: { ...counts },
  };
}

export function rejectPeopleImportRequest(
  state: PeopleImportUiState,
  request: PeopleImportUiRequest,
  failure: PeopleImportUiFailure,
): PeopleImportUiState {
  if (!isActiveRequest(state, request)) return state;

  const needsFreshPreview = request.kind === 'preview' || failure === 'import_conflict';
  return {
    ...state,
    pending: null,
    preview: needsFreshPreview ? null : state.preview,
    warningsAcknowledged: needsFreshPreview ? false : state.warningsAcknowledged,
    failure,
    success: null,
  };
}
