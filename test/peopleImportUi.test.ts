import { describe, expect, it } from 'vitest';
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
