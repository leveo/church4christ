import { describe, expect, it } from 'vitest';
import importPageSource from '../src/pages/admin/people/import/index.astro?raw';
import peoplePageSource from '../src/pages/admin/people/index.astro?raw';
import mappingPageSource from '../src/pages/admin/people/import/map/index.astro?raw';
import mappingUiSource from '../src/lib/peopleImportMappingUi.ts?raw';
import {
  PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS,
  PEOPLE_IMPORT_MAPPING_UI_ENUM_VALUES,
  PEOPLE_IMPORT_MAPPING_UI_FIELDS,
  classifyPeopleImportMappingCommitResponse,
  applyPeopleImportMappingCommit,
  applyPeopleImportMappingInspect,
  applyPeopleImportMappingPreview,
  applyPeopleImportMappingProfile,
  beginPeopleImportMappingRequest,
  clonePeopleImportMappingDraft,
  createPeopleImportMappingDraft,
  createPeopleImportMappingUiState,
  decidePeopleImportMappingFailure,
  editPeopleImportMappingDraft,
  mappingDraftConfig,
  parsePeopleImportMappingInspect,
  parsePeopleImportMappingPreview,
  parsePeopleImportMappingProfile,
  parsePeopleImportMappingProfiles,
  parsePeopleImportMappingResultCode,
  peopleImportMappingUiControls,
  rejectPeopleImportMappingRequest,
  selectPeopleImportMappingFile,
  selectPeopleImportMappingProfile,
  setPeopleImportMappingWarningAcknowledgement,
  updatePeopleImportMappingDraftField,
  updatePeopleImportMappingDraftTranslations,
} from '../src/lib/peopleImportMappingUi';

const summary = {
  dataRows: 2,
  people: 1,
  dependents: 1,
  households: 1,
  inactivePeople: 0,
};

const profileBody = {
  ok: true,
  profile: {
    id: 7,
    name: 'Legacy export',
    version: 1,
    expectedHeaders: ['kind', 'name'],
    fieldMappings: Object.fromEntries(
      PEOPLE_IMPORT_MAPPING_UI_FIELDS.map((field) => [field, field === 'display_name' ? 1 : null]),
    ),
    constants: { record_type: 'person' },
    enumTranslations: {},
    createdByPersonId: 12,
    createdAt: '2026-08-12 05:00:00',
  },
};

describe('people import mapping browser contract parsing', () => {
  it('exposes exactly 18 canonical fields and the six closed-enum constant fields', () => {
    expect(PEOPLE_IMPORT_MAPPING_UI_FIELDS).toHaveLength(18);
    expect(PEOPLE_IMPORT_MAPPING_UI_ENUM_FIELDS).toEqual([
      'record_type',
      'language',
      'membership_status',
      'active',
      'household_role',
      'household_primary',
    ]);
    expect(PEOPLE_IMPORT_MAPPING_UI_ENUM_VALUES).toEqual({
      record_type: ['person', 'dependent'],
      language: ['en', 'zh'],
      membership_status: ['visitor', 'regular', 'member', 'inactive'],
      active: ['true', 'false'],
      household_role: ['adult', 'child'],
      household_primary: ['true', 'false'],
    });
  });

  it('accepts only bounded exact inspect, profile-list, and profile response shapes', () => {
    expect(parsePeopleImportMappingInspect(200, {
      ok: true,
      headers: ['kind', 'name'],
      headerRowNumber: 1,
      dataRows: 2,
      issues: [],
    })).toEqual({ headers: ['kind', 'name'], headerRowNumber: 1, dataRows: 2, issues: [] });
    expect(parsePeopleImportMappingInspect(200, {
      ok: true,
      headers: new Array(129).fill('x'),
      headerRowNumber: 1,
      dataRows: 2,
      issues: [],
    })).toBeNull();
    expect(parsePeopleImportMappingInspect(200, {
      ok: true,
      headers: ['x'.repeat(5_001)],
      headerRowNumber: 1,
      dataRows: 2,
      issues: [],
    })).toBeNull();
    expect(parsePeopleImportMappingProfiles(200, {
      ok: true,
      profiles: [profileBody.profile],
    })).toEqual([{ id: 7, name: 'Legacy export', version: 1, createdAt: '2026-08-12 05:00:00' }]);
    expect(parsePeopleImportMappingProfile(200, profileBody)).toMatchObject({
      id: 7,
      name: 'Legacy export',
      expectedHeaders: ['kind', 'name'],
      constants: { record_type: 'person' },
    });
    expect(parsePeopleImportMappingProfile(404, profileBody)).toBeNull();
    expect(parsePeopleImportMappingProfiles(200, {
      ok: true,
      profiles: [{ ...profileBody.profile, name: 'x'.repeat(81) }],
    })).toBeNull();
    expect(parsePeopleImportMappingProfile(200, {
      ...profileBody,
      profile: { ...profileBody.profile, fieldMappings: { display_name: 1 } },
    })).toBeNull();
    expect(parsePeopleImportMappingProfile(200, {
      ...profileBody,
      profile: {
        ...profileBody.profile,
        constants: { record_type: 'person' },
        enumTranslations: { record_type: { member: 'person' } },
      },
    })).toBeNull();
    expect(parsePeopleImportMappingProfile(200, {
      ...profileBody,
      profile: {
        ...profileBody.profile,
        fieldMappings: { ...profileBody.profile.fieldMappings, record_type: 0 },
        constants: {},
        enumTranslations: { record_type: { member: 'person' } },
      },
    }))?.toMatchObject({ fieldMappings: { record_type: 0 }, constants: {} });
  });

  it('parses mapping issues separately from canonical preview issues and rows', () => {
    const result = parsePeopleImportMappingPreview(200, {
      ok: true,
      profile: { id: 7, name: 'Legacy export', version: 1 },
      mappingIssues: [{ code: 'header_drift', row: 1, column: 2, field: null }],
      preview: null,
    });
    expect(result).toEqual({
      profile: { id: 7, name: 'Legacy export', version: 1 },
      mappingIssues: [{ code: 'header_drift', row: 1, column: 2, field: null }],
      preview: null,
    });

    expect(parsePeopleImportMappingPreview(200, {
      ok: true,
      profile: { id: 7, name: 'Legacy export', version: 1 },
      mappingIssues: [],
      preview: {
        ok: true,
        summary,
        rows: [{ row: 2, recordType: 'person', displayName: 'Ada', email: '', household: null }],
        households: [],
        issues: [{ severity: 'warning', code: 'household_name_exists', row: 2, field: 'household_name' }],
      },
    }))?.toMatchObject({ preview: { summary, issues: [{ severity: 'warning' }] } });
  });

  it('treats every unrecognized commit response as uncertain but preserves recognized failures', () => {
    const uncertain = {
      messageKey: 'admin.peopleImportMapping.failure.uncertainCommit',
      clearPreview: true,
      clearProfile: false,
      checkPeople: true,
    };
    for (const [status, body] of [
      [201, null],
      [201, { ok: true, counts: { people: '1', households: 0, dependents: 0 } }],
      [200, { ok: true, counts: { people: 1, households: 0, dependents: 0 } }],
      [500, { message: 'upstream HTML or malformed JSON snapshot' }],
      [201, { ok: false, code: 'generic_error' }],
      [201, { ok: true, code: 'import_failed' }],
      [500, { ok: true, code: 'import_failed' }],
      [500, { ok: false, code: 'import_failed', counts: { people: 1, households: 0, dependents: 0 } }],
      [201, { ok: true, code: 'import_failed', counts: { people: 1, households: 0, dependents: 0 } }],
      [201, { ok: true, counts: { people: 1, households: 0, dependents: 0, extra: 1 } }],
    ] as const) {
      expect(classifyPeopleImportMappingCommitResponse(status, body)).toEqual({
        ok: false,
        decision: uncertain,
      });
    }

    for (const code of ['generic_error', 'import_failed'] as const) {
      expect(classifyPeopleImportMappingCommitResponse(500, {
        ok: false,
        code,
      })).toEqual({
        ok: false,
        decision: {
          messageKey: `admin.peopleImportMapping.result.${code}`,
          clearPreview: false,
          clearProfile: false,
          checkPeople: false,
        },
      });
    }
    expect(classifyPeopleImportMappingCommitResponse(201, {
      ok: true,
      counts: { people: 1, households: 0, dependents: 0 },
    })).toEqual({ ok: true, counts: { people: 1, households: 0, dependents: 0 } });
  });

  it('accepts each exact commit error status/code pair and rejects any mismatch', () => {
    const pairs = {
      multipart_required: 415, multipart_invalid: 400, missing_file: 400,
      file_too_large: 413, file_type_invalid: 415, mapping_config_too_large: 413,
      mapping_config_invalid: 400, mapping_source_invalid: 400, profile_name_invalid: 400,
      profile_id_invalid: 400, mapping_profile_invalid: 400, mapping_profile_conflict: 409,
      mapping_profile_corrupt: 500, mapping_profile_failed: 500, mapping_profile_not_found: 404,
      validation_failed: 400, warnings_not_acknowledged: 409, import_conflict: 409,
      import_failed: 500, generic_error: 500, forbidden: 403, not_found: 404,
      method_not_allowed: 405,
    } as const;
    for (const [code, status] of Object.entries(pairs)) {
      expect(classifyPeopleImportMappingCommitResponse(status, { ok: false, code })).toMatchObject({
        ok: false,
        decision: { messageKey: `admin.peopleImportMapping.result.${code}` },
      });
      expect(classifyPeopleImportMappingCommitResponse(status === 400 ? 409 : 400, {
        ok: false,
        code,
      })).toMatchObject({
        ok: false,
        decision: { messageKey: 'admin.peopleImportMapping.failure.uncertainCommit', clearPreview: true },
      });
    }
  });

  it('recognizes non-commit errors only from valid status and failure bodies', () => {
    expect(parsePeopleImportMappingResultCode(500, { ok: false, code: 'generic_error' })).toBe('generic_error');
    expect(parsePeopleImportMappingResultCode(201, { ok: false, code: 'generic_error' })).toBeNull();
    expect(parsePeopleImportMappingResultCode(500, { ok: true, code: 'generic_error' })).toBeNull();
    expect(parsePeopleImportMappingResultCode(500, {
      ok: false,
      code: 'generic_error',
      profile: profileBody.profile,
    })).toBeNull();
  });
});

describe('people import mapping draft contract', () => {
  it('builds an exact 18-field source/empty draft and limits constants to closed enums', () => {
    let draft = createPeopleImportMappingDraft(['kind', 'name']);
    draft = updatePeopleImportMappingDraftField(draft, 'display_name', { mode: 'source', sourceIndex: 1 })!;
    draft = updatePeopleImportMappingDraftField(draft, 'record_type', { mode: 'constant', value: 'person' })!;
    expect(updatePeopleImportMappingDraftField(draft, 'email', { mode: 'constant', value: 'person' })).toBeNull();

    expect(mappingDraftConfig(draft)).toEqual({
      fieldMappings: {
        ...Object.fromEntries(PEOPLE_IMPORT_MAPPING_UI_FIELDS.map((field) => [field, null])),
        display_name: 1,
      },
      constants: { record_type: 'person' },
      enumTranslations: {},
    });
  });

  it('normalizes manual source tokens, rejects partial/duplicate rows, and never stores samples', () => {
    let draft = createPeopleImportMappingDraft(['kind']);
    draft = updatePeopleImportMappingDraftField(draft, 'record_type', { mode: 'source', sourceIndex: 0 })!;
    draft = updatePeopleImportMappingDraftTranslations(draft, 'record_type', [
      { source: ' Member ', target: 'person' },
      { source: 'CHILD', target: 'dependent' },
    ])!;
    expect(mappingDraftConfig(draft)?.enumTranslations).toEqual({
      record_type: { member: 'person', child: 'dependent' },
    });
    expect(JSON.stringify(draft)).not.toMatch(/sample|sourceRows|rowValues/i);
    expect(updatePeopleImportMappingDraftTranslations(draft, 'record_type', [
      { source: 'member', target: 'person' },
      { source: ' MEMBER ', target: 'dependent' },
    ])).toBeNull();
    expect(updatePeopleImportMappingDraftTranslations(draft, 'record_type', [
      { source: '', target: 'person' },
    ])).toBeNull();
    expect(updatePeopleImportMappingDraftTranslations(draft, 'record_type', [
      { source: 'x'.repeat(5_001), target: 'person' },
    ])).toBeNull();
  });

  it('clones an immutable profile into a detached create-only draft', () => {
    const profile = parsePeopleImportMappingProfile(200, profileBody)!;
    const clone = clonePeopleImportMappingDraft(profile);
    expect(mappingDraftConfig(clone)).toEqual({
      fieldMappings: profile.fieldMappings,
      constants: profile.constants,
      enumTranslations: profile.enumTranslations,
    });
    clone.expectedHeaders[0] = 'changed';
    expect(profile.expectedHeaders[0]).toBe('kind');
  });
});

describe('people import mapping revision state', () => {
  const inspection = parsePeopleImportMappingInspect(200, {
    ok: true,
    headers: ['kind', 'name'],
    headerRowNumber: 1,
    dataRows: 2,
    issues: [],
  })!;
  const profile = parsePeopleImportMappingProfile(200, profileBody)!;

  it('discards stale responses across file, profile, and draft revisions', () => {
    let state = selectPeopleImportMappingFile(createPeopleImportMappingUiState(), true);
    const inspect = beginPeopleImportMappingRequest(state, 'inspect')!;
    state = selectPeopleImportMappingFile(inspect.state, true);
    expect(applyPeopleImportMappingInspect(state, inspect.request, inspection)).toEqual(state);

    state = applyPeopleImportMappingInspect(
      beginPeopleImportMappingRequest(state, 'inspect')!.state,
      beginPeopleImportMappingRequest(state, 'inspect')!.request,
      inspection,
    );
    const selected = selectPeopleImportMappingProfile(state, profile);
    const preview = beginPeopleImportMappingRequest(selected, 'preview')!;
    const edited = editPeopleImportMappingDraft(preview.state, clonePeopleImportMappingDraft(profile));
    expect(applyPeopleImportMappingPreview(edited, preview.request, {
      profile: { id: 7, name: 'Legacy export', version: 1 }, mappingIssues: [], preview: null,
    })).toEqual(edited);
  });

  it('fails closed when a preview response belongs to a different profile', () => {
    let state = selectPeopleImportMappingFile(createPeopleImportMappingUiState(), true);
    const inspect = beginPeopleImportMappingRequest(state, 'inspect')!;
    state = applyPeopleImportMappingInspect(inspect.state, inspect.request, inspection);
    state = selectPeopleImportMappingProfile(state, profile);
    const preview = beginPeopleImportMappingRequest(state, 'preview')!;

    expect(preview.request.profileId).toBe(profile.id);
    const rejected = applyPeopleImportMappingPreview(preview.state, preview.request, {
      profile: { id: profile.id + 1, name: 'Wrong profile', version: 1 },
      mappingIssues: [],
      preview: { summary, rows: [], issues: [] },
    });
    expect(rejected).toMatchObject({ pending: null, preview: null, warningsAcknowledged: false });
    expect(peopleImportMappingUiControls(rejected).commitDisabled).toBe(true);
  });

  it('clears preview and literal acknowledgement when file, profile, or draft changes', () => {
    let state = selectPeopleImportMappingFile(createPeopleImportMappingUiState(), true);
    const inspect = beginPeopleImportMappingRequest(state, 'inspect')!;
    state = applyPeopleImportMappingInspect(inspect.state, inspect.request, inspection);
    state = selectPeopleImportMappingProfile(state, profile);
    const preview = beginPeopleImportMappingRequest(state, 'preview')!;
    state = applyPeopleImportMappingPreview(preview.state, preview.request, {
      profile: { id: 7, name: 'Legacy export', version: 1 },
      mappingIssues: [],
      preview: { summary, rows: [], issues: [{ severity: 'warning', code: 'x', row: null, field: null }] },
    });
    state = setPeopleImportMappingWarningAcknowledgement(state, 'true');
    expect(state.warningsAcknowledged).toBe(false);
    state = setPeopleImportMappingWarningAcknowledgement(state, true);
    expect(peopleImportMappingUiControls(state).commitDisabled).toBe(false);

    expect(selectPeopleImportMappingProfile(state, profile)).toMatchObject({ preview: null, warningsAcknowledged: false });
    expect(editPeopleImportMappingDraft(state, clonePeopleImportMappingDraft(profile))).toMatchObject({ preview: null, warningsAcknowledged: false });
    expect(selectPeopleImportMappingFile(state, true)).toMatchObject({ preview: null, warningsAcknowledged: false });
  });

  it('allows a file change during preview but locks file, profile, and draft during commit', () => {
    let state = selectPeopleImportMappingFile(createPeopleImportMappingUiState(), true);
    const inspect = beginPeopleImportMappingRequest(state, 'inspect')!;
    state = applyPeopleImportMappingInspect(inspect.state, inspect.request, inspection);
    state = selectPeopleImportMappingProfile(state, profile);
    const previewRequest = beginPeopleImportMappingRequest(state, 'preview')!;
    expect(peopleImportMappingUiControls(previewRequest.state)).toMatchObject({ fileDisabled: false });
    expect(selectPeopleImportMappingFile(previewRequest.state, true).fileRevision).toBe(state.fileRevision + 1);

    state = applyPeopleImportMappingPreview(previewRequest.state, previewRequest.request, {
      profile: { id: 7, name: 'Legacy export', version: 1 }, mappingIssues: [],
      preview: { summary, rows: [], issues: [] },
    });
    const commit = beginPeopleImportMappingRequest(state, 'commit')!;
    expect(peopleImportMappingUiControls(commit.state)).toMatchObject({
      fileDisabled: true,
      profileDisabled: true,
      draftDisabled: true,
    });
    expect(selectPeopleImportMappingFile(commit.state, true)).toEqual(commit.state);
    expect(selectPeopleImportMappingProfile(commit.state, null)).toEqual(commit.state);
    expect(editPeopleImportMappingDraft(commit.state, createPeopleImportMappingDraft(['new']))).toEqual(commit.state);
    expect(applyPeopleImportMappingCommit(commit.state, commit.request, {
      people: 1, households: 1, dependents: 1,
    }).success).toEqual({ people: 1, households: 1, dependents: 1 });
  });

  it('locks every profile-creation input until the mutating request settles', () => {
    let state = selectPeopleImportMappingFile(createPeopleImportMappingUiState(), true);
    const inspect = beginPeopleImportMappingRequest(state, 'inspect')!;
    state = applyPeopleImportMappingInspect(inspect.state, inspect.request, inspection);
    state = editPeopleImportMappingDraft(state, createPeopleImportMappingDraft(inspection.headers!));
    const create = beginPeopleImportMappingRequest(state, 'create')!;

    expect(peopleImportMappingUiControls(create.state)).toMatchObject({
      fileDisabled: true,
      profileDisabled: true,
      draftDisabled: true,
    });
    expect(selectPeopleImportMappingFile(create.state, true)).toEqual(create.state);
    expect(selectPeopleImportMappingProfile(create.state, profile)).toEqual(create.state);
    expect(editPeopleImportMappingDraft(create.state, createPeopleImportMappingDraft(['changed']))).toEqual(create.state);
    expect(applyPeopleImportMappingProfile(create.state, create.request, profile)).toMatchObject({
      pending: null,
      selectedProfile: profile,
    });
  });

  it('keeps profile and draft controls locked while inspection owns the only current file result', () => {
    const state = selectPeopleImportMappingFile(createPeopleImportMappingUiState(), true);
    const inspect = beginPeopleImportMappingRequest(state, 'inspect')!;

    expect(peopleImportMappingUiControls(inspect.state)).toMatchObject({
      fileDisabled: false,
      profileDisabled: true,
      draftDisabled: true,
    });
    expect(selectPeopleImportMappingProfile(inspect.state, profile)).toEqual(inspect.state);
    expect(editPeopleImportMappingDraft(inspect.state, createPeopleImportMappingDraft(['changed']))).toEqual(inspect.state);
    expect(selectPeopleImportMappingFile(inspect.state, true).fileRevision).toBe(state.fileRevision + 1);
  });

  it('describes an unknown profile-create result as possibly saved', () => {
    expect(decidePeopleImportMappingFailure('create', null, true)).toEqual({
      messageKey: 'admin.peopleImportMapping.failure.uncertainCreate',
      clearPreview: false,
      clearProfile: false,
      checkPeople: false,
    });
  });

  it('requires People verification and a fresh preview after uncertain/conflicting commits', () => {
    expect(decidePeopleImportMappingFailure('commit', null, true)).toEqual({
      messageKey: 'admin.peopleImportMapping.failure.uncertainCommit',
      clearPreview: true,
      clearProfile: false,
      checkPeople: true,
    });
    for (const code of ['import_conflict', 'warnings_not_acknowledged', 'validation_failed'] as const) {
      expect(decidePeopleImportMappingFailure('commit', code, false)).toMatchObject({
        clearPreview: true,
        checkPeople: code === 'import_conflict',
      });
    }
    expect(decidePeopleImportMappingFailure('preview', 'mapping_profile_not_found', false)).toMatchObject({
      clearPreview: true,
      clearProfile: true,
    });
  });

  it('applies an unrecognized commit response by clearing preview and literal acknowledgement', () => {
    let state = selectPeopleImportMappingFile(createPeopleImportMappingUiState(), true);
    const inspect = beginPeopleImportMappingRequest(state, 'inspect')!;
    state = applyPeopleImportMappingInspect(inspect.state, inspect.request, inspection);
    state = selectPeopleImportMappingProfile(state, profile);
    const preview = beginPeopleImportMappingRequest(state, 'preview')!;
    state = applyPeopleImportMappingPreview(preview.state, preview.request, {
      profile: { id: 7, name: 'Legacy export', version: 1 }, mappingIssues: [],
      preview: { summary, rows: [], issues: [{ severity: 'warning', code: 'x', row: null, field: null }] },
    });
    state = setPeopleImportMappingWarningAcknowledgement(state, true);
    const commit = beginPeopleImportMappingRequest(state, 'commit')!;
    const failure = classifyPeopleImportMappingCommitResponse(201, null);
    expect(failure.ok).toBe(false);
    if (failure.ok) throw new Error('Expected an uncertain commit response.');
    const rejected = rejectPeopleImportMappingRequest(commit.state, commit.request, failure.decision);
    expect(rejected).toMatchObject({
      pending: null,
      preview: null,
      warningsAcknowledged: false,
    });
    expect(failure.decision.checkPeople).toBe(true);
    expect(peopleImportMappingUiControls(rejected).commitDisabled).toBe(true);
  });
});

describe('people import mapping page contract', () => {
  it('guards before the shell and never loads DB data in frontmatter', () => {
    expect(mappingPageSource).toContain('canManagePeopleImport');
    expect(mappingPageSource.indexOf('canManagePeopleImport')).toBeLessThan(mappingPageSource.indexOf('<Admin'));
    expect(mappingPageSource).toContain("access === 'not_found'");
    expect(mappingPageSource).toContain("access === 'forbidden'");
    expect(mappingPageSource).not.toMatch(/listPeopleImportMappings|getPeopleImportMapping|Astro\.locals\.db/);
  });

  it('uses one retained File and only authoritative absolute mapping endpoints', () => {
    expect(mappingPageSource).toMatch(/let selectedFile:\s*File \| null/);
    for (const path of [
      '/admin/people/import/map/inspect',
      '/admin/people/import/map/profiles',
      '/admin/people/import/map/preview',
      '/admin/people/import/map/commit',
    ]) expect(mappingPageSource).toContain(path);
    expect(mappingPageSource).toContain("form.append('csv', file)");
    expect(mappingPageSource).toContain("form.append('profile_id'");
    expect(mappingPageSource).toContain("form.append('mapping_config'");
    expect(mappingPageSource).toContain("form.append('profile_name'");
    expect(mappingPageSource).toContain("form.append('acknowledge_warnings', 'true')");
    expect(mappingPageSource).not.toMatch(/form\.append\(['"](?:model|role|op)['"]/);
    expect(mappingPageSource).toContain('classifyPeopleImportMappingCommitResponse(response.status, body)');
    expect(mappingPageSource).not.toContain('parsePeopleImportMappingCommit(response.status, body)');
    expect(mappingPageSource).toContain('preview.profile.id !== operation.request.profileId');
  });

  it('renders dynamic values only through safe DOM APIs without browser persistence or logging', () => {
    expect(mappingPageSource).toContain('.textContent =');
    expect(mappingPageSource).toContain('document.createElement');
    expect(mappingPageSource).toContain('.replaceChildren(');
    expect(mappingPageSource).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|set:html/);
    expect(mappingPageSource).not.toMatch(/localStorage|sessionStorage|console\.(?:log|info|warn|error|debug)/);
    expect(mappingUiSource).toContain("from './peopleImportMappingContract'");
    expect(mappingUiSource).not.toMatch(/peopleImportMappingHttp|peopleImportMappingDb/);
  });

  it('hydrates only an explicit client copy allowlist instead of the complete import dictionary', () => {
    expect(mappingPageSource).toContain('const clientCopyKeys = [');
    expect(mappingPageSource).toContain('...PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES.map');
    expect(mappingPageSource).not.toMatch(/Object\.keys\(en\)|startsWith\(['"]admin\.peopleImport/);
  });

  it('locks the profile-name and translation controls for mutating profile creation', () => {
    expect(mappingPageSource).toContain('profileNameInput.disabled = controls.draftDisabled');
    expect(mappingPageSource).toContain('control.disabled = controls.draftDisabled');
    expect(mappingPageSource).toContain('admin.peopleImportMapping.failure.uncertainCreate');
  });

  it('resynchronizes manual translation controls after a mapping-mode edit', () => {
    const setDraft = mappingPageSource.match(/function setDraft[\s\S]*?async function saveProfile/)?.[0];
    expect(setDraft).toContain('captureTranslationInputs();');
  });

  it('adds the mapping workflow only behind both People-module and area grants', () => {
    expect(importPageSource).toContain("href=\"/admin/people/import/map\"");
    expect(importPageSource).toMatch(/hasPeople\s*&&\s*canManagePeople/);
    expect(peoplePageSource).toContain("href=\"/admin/people/import/map\"");
    expect(peoplePageSource).toMatch(/hasPeople\s*&&\s*canManagePeople/);
  });
});
