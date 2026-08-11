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
