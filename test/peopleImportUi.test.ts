import { describe, expect, it } from 'vitest';
import importPageSource from '../src/pages/admin/people/import/index.astro?raw';
import peopleImportUiSource from '../src/lib/peopleImportUi.ts?raw';
import {
  applyPeopleImportCommit,
  applyPeopleImportPreview,
  beginPeopleImportCommit,
  beginPeopleImportPreview,
  createPeopleImportUiState,
  decidePeopleImportFailure,
  parsePeopleImportCounts,
  parsePeopleImportPreview,
  parsePeopleImportResultCode,
  parsePeopleImportSummary,
  peopleImportUiControls,
  rejectPeopleImportRequest,
  selectPeopleImportFile,
  setPeopleImportWarningsAcknowledged,
  type PeopleImportUiSummary,
} from '../src/lib/peopleImportUi';

const summary: PeopleImportUiSummary = {
  dataRows: 3,
  people: 2,
  dependents: 1,
  households: 1,
  inactivePeople: 0,
};

describe('people import UI state', () => {
  it('increments the selected-file revision and resets preview state when the file changes', () => {
    let state = selectPeopleImportFile(createPeopleImportUiState(), true);
    const preview = beginPeopleImportPreview(state);
    expect(preview).not.toBeNull();
    state = applyPeopleImportPreview(preview!.state, preview!.request, {
      summary,
      issues: [{ severity: 'warning' }],
    });
    state = setPeopleImportWarningsAcknowledged(state, true);

    const changed = selectPeopleImportFile(state, true);

    expect(changed).toMatchObject({
      fileRevision: 2,
      hasFile: true,
      pending: null,
      preview: null,
      warningsAcknowledged: false,
      failure: null,
      success: null,
    });
  });

  it('discards an async preview response for an older selected file', () => {
    const first = selectPeopleImportFile(createPeopleImportUiState(), true);
    const request = beginPeopleImportPreview(first)!;
    const second = selectPeopleImportFile(request.state, true);

    const afterStaleResponse = applyPeopleImportPreview(second, request.request, {
      summary,
      issues: [],
    });

    expect(afterStaleResponse).toEqual(second);
  });

  it('disables both actions while preview or commit is pending', () => {
    let state = createPeopleImportUiState();
    expect(peopleImportUiControls(state)).toEqual({
      previewDisabled: true,
      commitDisabled: true,
      fileDisabled: false,
    });

    state = selectPeopleImportFile(state, true);
    expect(peopleImportUiControls(state)).toEqual({
      previewDisabled: false,
      commitDisabled: true,
      fileDisabled: false,
    });

    const preview = beginPeopleImportPreview(state)!;
    expect(peopleImportUiControls(preview.state)).toEqual({
      previewDisabled: true,
      commitDisabled: true,
      fileDisabled: false,
    });

    state = applyPeopleImportPreview(preview.state, preview.request, { summary, issues: [] });
    expect(peopleImportUiControls(state)).toEqual({
      previewDisabled: false,
      commitDisabled: false,
      fileDisabled: false,
    });

    const commit = beginPeopleImportCommit(state)!;
    expect(peopleImportUiControls(commit.state)).toEqual({
      previewDisabled: true,
      commitDisabled: true,
      fileDisabled: true,
    });
  });

  it('blocks commit whenever the preview contains an error', () => {
    let state = selectPeopleImportFile(createPeopleImportUiState(), true);
    const preview = beginPeopleImportPreview(state)!;
    state = applyPeopleImportPreview(preview.state, preview.request, {
      summary,
      issues: [{ severity: 'error' }, { severity: 'warning' }],
    });
    state = setPeopleImportWarningsAcknowledged(state, true);

    expect(peopleImportUiControls(state).commitDisabled).toBe(true);
    expect(beginPeopleImportCommit(state)).toBeNull();
  });

  it('requires the literal boolean true to acknowledge preview warnings', () => {
    let state = selectPeopleImportFile(createPeopleImportUiState(), true);
    const preview = beginPeopleImportPreview(state)!;
    state = applyPeopleImportPreview(preview.state, preview.request, {
      summary,
      issues: [{ severity: 'warning' }],
    });

    state = setPeopleImportWarningsAcknowledged(state, 'true');
    expect(state.warningsAcknowledged).toBe(false);
    expect(peopleImportUiControls(state).commitDisabled).toBe(true);

    state = setPeopleImportWarningsAcknowledged(state, true);
    expect(state.warningsAcknowledged).toBe(true);
    expect(peopleImportUiControls(state).commitDisabled).toBe(false);
  });

  it('forces a fresh preview after a commit conflict', () => {
    let state = selectPeopleImportFile(createPeopleImportUiState(), true);
    const preview = beginPeopleImportPreview(state)!;
    state = applyPeopleImportPreview(preview.state, preview.request, { summary, issues: [] });
    const commit = beginPeopleImportCommit(state)!;

    state = rejectPeopleImportRequest(commit.state, commit.request, 'import_conflict');

    expect(state).toMatchObject({
      pending: null,
      preview: null,
      warningsAcknowledged: false,
      failure: 'import_conflict',
      success: null,
    });
    expect(peopleImportUiControls(state)).toEqual({
      previewDisabled: false,
      commitDisabled: true,
      fileDisabled: false,
    });
  });

  it('retains exact success counts from the active commit response', () => {
    let state = selectPeopleImportFile(createPeopleImportUiState(), true);
    const preview = beginPeopleImportPreview(state)!;
    state = applyPeopleImportPreview(preview.state, preview.request, { summary, issues: [] });
    const commit = beginPeopleImportCommit(state)!;

    state = applyPeopleImportCommit(commit.state, commit.request, {
      people: 2,
      households: 1,
      dependents: 1,
    });

    expect(state.success).toEqual({ people: 2, households: 1, dependents: 1 });
    expect(state.pending).toBeNull();
    expect(peopleImportUiControls(commit.state).fileDisabled).toBe(true);
    expect(peopleImportUiControls(state).fileDisabled).toBe(false);
    expect(peopleImportUiControls(state).commitDisabled).toBe(true);
  });
});

describe('people import response parsing', () => {
  const previewBody = {
    ok: true,
    summary,
    rows: [
      {
        row: 2,
        recordType: 'person',
        displayName: '<b>Ada</b>',
        email: 'ada@example.com',
        household: { name: 'Example Household' },
      },
    ],
    issues: [
      { severity: 'warning', code: 'household_name_exists', row: null, field: 'household_name' },
    ],
  };

  it('rejects malformed or non-200 preview JSON without trusting nested values', () => {
    expect(parsePeopleImportSummary(null)).toBeNull();
    expect(parsePeopleImportSummary({ ...summary, people: -1 })).toBeNull();
    expect(parsePeopleImportPreview(500, previewBody)).toBeNull();
    expect(parsePeopleImportPreview(200, { ...previewBody, ok: false })).toBeNull();
    expect(parsePeopleImportPreview(200, null)).toBeNull();
    expect(parsePeopleImportPreview(200, { ...previewBody, rows: [{}] })).toBeNull();
    expect(parsePeopleImportPreview(200, {
      ...previewBody,
      issues: [{ severity: 'notice', code: 'unknown', row: null, field: null }],
    })).toBeNull();
  });

  it('projects a valid preview response into safe primitive UI values', () => {
    expect(parsePeopleImportPreview(200, previewBody)).toEqual({
      summary,
      rows: [{
        row: 2,
        recordType: 'person',
        displayName: '<b>Ada</b>',
        email: 'ada@example.com',
        householdName: 'Example Household',
      }],
      issues: [{
        severity: 'warning',
        code: 'household_name_exists',
        row: null,
        field: 'household_name',
      }],
    });
  });

  it('keeps an incomplete household row and its validation issue in the preview', () => {
    const incompleteBody = {
      ...previewBody,
      rows: [{
        ...previewBody.rows[0],
        household: { name: null },
      }],
      issues: [{
        severity: 'error',
        code: 'household_name_required',
        row: 2,
        field: 'household_name',
      }],
    };

    expect(parsePeopleImportPreview(200, incompleteBody)).toEqual({
      summary,
      rows: [{
        row: 2,
        recordType: 'person',
        displayName: '<b>Ada</b>',
        email: 'ada@example.com',
        householdName: '',
      }],
      issues: [{
        severity: 'error',
        code: 'household_name_required',
        row: 2,
        field: 'household_name',
      }],
    });
  });

  it('accepts commit counts only from an exact 201 success response', () => {
    const body = { ok: true, counts: { people: 2, households: 1, dependents: 1 } };
    expect(parsePeopleImportCounts(201, body)).toEqual(body.counts);
    expect(parsePeopleImportCounts(201, { ...body, ok: false })).toBeNull();
    expect(parsePeopleImportCounts(200, body)).toBeNull();
    expect(parsePeopleImportCounts(201, { ...body, counts: { ...body.counts, people: -1 } })).toBeNull();
    expect(parsePeopleImportCounts(201, null)).toBeNull();
  });

  it('accepts only a shared, explicit HTTP result code', () => {
    expect(parsePeopleImportResultCode({ code: 'forbidden' })).toBe('forbidden');
    expect(parsePeopleImportResultCode({ code: 'made_up' })).toBeNull();
    expect(parsePeopleImportResultCode(null)).toBeNull();
  });

  it('keeps the browser state module isolated from server HTTP and persistence dependencies', () => {
    expect(peopleImportUiSource).toContain("from './peopleImportContract'");
    expect(peopleImportUiSource).not.toContain("from './peopleImportHttp'");
  });
});

describe('people import failure decisions', () => {
  it('treats generic and transport commit failures as uncertain and requires a fresh preview', () => {
    expect(decidePeopleImportFailure('commit', 'generic_error', false)).toEqual({
      failure: 'generic',
      messageKey: 'admin.peopleImport.genericError',
      requiresFreshPreview: true,
    });
    expect(decidePeopleImportFailure('commit', null, true)).toEqual({
      failure: 'network',
      messageKey: 'admin.peopleImport.genericError',
      requiresFreshPreview: true,
    });
  });

  it('distinguishes a failed preview response from a true preview network failure', () => {
    expect(decidePeopleImportFailure('preview', 'generic_error', false)).toEqual({
      failure: 'generic',
      messageKey: 'admin.peopleImport.previewError',
      requiresFreshPreview: false,
    });
    expect(decidePeopleImportFailure('preview', null, true)).toEqual({
      failure: 'network',
      messageKey: 'admin.peopleImport.networkError',
      requiresFreshPreview: false,
    });
  });

  it('forces a re-preview for late warnings and conflicts but preserves accurate result copy', () => {
    expect(decidePeopleImportFailure('commit', 'warnings_not_acknowledged', false)).toEqual({
      failure: 'generic',
      messageKey: 'admin.peopleImport.repreviewRequired',
      requiresFreshPreview: true,
    });
    expect(decidePeopleImportFailure('commit', 'import_conflict', false)).toEqual({
      failure: 'import_conflict',
      messageKey: 'admin.peopleImport.repreviewRequired',
      requiresFreshPreview: true,
    });
    expect(decidePeopleImportFailure('commit', 'validation_failed', false)).toEqual({
      failure: 'generic',
      messageKey: 'admin.peopleImport.result.validation_failed',
      requiresFreshPreview: true,
    });
    for (const code of ['forbidden', 'not_found', 'method_not_allowed', 'missing_file', 'import_failed'] as const) {
      expect(decidePeopleImportFailure('commit', code, false)).toEqual({
        failure: 'generic',
        messageKey: `admin.peopleImport.result.${code}`,
        requiresFreshPreview: false,
      });
    }
  });
});

describe('people import admin page contract', () => {
  it('repeats module and full-grant authorization before rendering the shell', () => {
    expect(importPageSource).toContain('canManagePeopleImport');
    expect(importPageSource).toContain("access === 'not_found'");
    expect(importPageSource).toContain('status: 404');
    expect(importPageSource).toContain("access === 'forbidden'");
    expect(importPageSource).toContain('status: 403');
    expect(importPageSource.indexOf('canManagePeopleImport')).toBeLessThan(
      importPageSource.indexOf('<Admin'),
    );
  });

  it('server-renders the operational limits, privacy, create-only, and D1 notices', () => {
    for (const key of [
      'admin.peopleImport.limits',
      'admin.peopleImport.privacy',
      'admin.peopleImport.createOnly',
      'admin.peopleImport.d1Notice',
    ]) {
      expect(importPageSource).toContain(key);
    }
  });

  it('uses absolute import URLs and retains a browser File for both requests', () => {
    expect(importPageSource).toContain('/admin/people/import/template.csv');
    expect(importPageSource).toContain("'/admin/people/import/preview'");
    expect(importPageSource).toContain("'/admin/people/import/commit'");
    expect(importPageSource).toMatch(/let selectedFile:\s*File \| null/);
    expect(importPageSource).toContain("form.append('csv', file)");
    for (const helper of [
      'selectPeopleImportFile',
      'beginPeopleImportPreview',
      'applyPeopleImportPreview',
      'beginPeopleImportCommit',
      'applyPeopleImportCommit',
      'rejectPeopleImportRequest',
      'parsePeopleImportPreview',
      'parsePeopleImportCounts',
      'decidePeopleImportFailure',
    ]) {
      expect(importPageSource).toContain(helper);
    }
  });

  it('binds the pure commit-pending file lock to the actual file input', () => {
    expect(importPageSource).toContain('fileInput.disabled = controls.fileDisabled');
  });

  it('renders uploaded and response values only through safe DOM text APIs', () => {
    expect(importPageSource).toContain('.textContent =');
    expect(importPageSource).toContain('document.createElement');
    expect(importPageSource).toContain('.replaceChildren(');
    expect(importPageSource).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|set:html/);
    expect(importPageSource).not.toMatch(/localStorage|sessionStorage|URLSearchParams/);
    expect(importPageSource).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
  });
});
