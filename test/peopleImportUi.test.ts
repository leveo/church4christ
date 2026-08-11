import { describe, expect, it } from 'vitest';
import importPageSource from '../src/pages/admin/people/import/index.astro?raw';
import {
  applyPeopleImportCommit,
  applyPeopleImportPreview,
  beginPeopleImportCommit,
  beginPeopleImportPreview,
  createPeopleImportUiState,
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
    expect(peopleImportUiControls(state)).toEqual({ previewDisabled: true, commitDisabled: true });

    state = selectPeopleImportFile(state, true);
    expect(peopleImportUiControls(state)).toEqual({ previewDisabled: false, commitDisabled: true });

    const preview = beginPeopleImportPreview(state)!;
    expect(peopleImportUiControls(preview.state)).toEqual({ previewDisabled: true, commitDisabled: true });

    state = applyPeopleImportPreview(preview.state, preview.request, { summary, issues: [] });
    expect(peopleImportUiControls(state)).toEqual({ previewDisabled: false, commitDisabled: false });

    const commit = beginPeopleImportCommit(state)!;
    expect(peopleImportUiControls(commit.state)).toEqual({ previewDisabled: true, commitDisabled: true });
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
    expect(peopleImportUiControls(state)).toEqual({ previewDisabled: false, commitDisabled: true });
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
    expect(peopleImportUiControls(state).commitDisabled).toBe(true);
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
    ]) {
      expect(importPageSource).toContain(helper);
    }
  });

  it('forces a fresh preview when commit discovers warnings that were not in the preview', () => {
    expect(importPageSource).toContain("code === 'warnings_not_acknowledged'");
    expect(importPageSource).toMatch(
      /commitNeedsFreshPreview[\s\S]*warnings_not_acknowledged[\s\S]*selectPeopleImportFile/,
    );
    expect(importPageSource).toMatch(
      /code === 'import_conflict'\s*\|\|\s*code === 'warnings_not_acknowledged'[\s\S]*admin\.peopleImport\.repreviewRequired/,
    );
  });

  it('distinguishes a safe preview failure from a network error and an uncertain commit', () => {
    expect(importPageSource).toContain('admin.peopleImport.previewError');
    expect(importPageSource).toMatch(
      /request\.kind === 'commit'[\s\S]*admin\.peopleImport\.genericError[\s\S]*requestWasUncertain[\s\S]*admin\.peopleImport\.networkError[\s\S]*admin\.peopleImport\.previewError/,
    );
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
