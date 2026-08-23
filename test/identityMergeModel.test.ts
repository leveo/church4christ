import { describe, expect, it } from 'vitest';
import {
  IDENTITY_MERGE_ACTIVE_CREDENTIAL_SOURCES,
  IDENTITY_MERGE_RISK_FACT_CATEGORIES,
  assertIdentityMergePreviewFresh,
  buildIdentityMergePreviewSnapshot,
  buildIdentityMergeResolutionCaseBinding,
  buildIdentityMergeRiskState,
  classifyIdentityMergeRisk,
  hashIdentityMergePreview,
  requiredIdentityMergeDecisions,
  type IdentityMergeRiskFacts,
} from '../src/lib/identityMergeModel';

const fact = (loserCount = 0, canonicalCount = 0, collisionCount = 0) => ({
  loserCount, canonicalCount, presenceCount: loserCount + canonicalCount, collisionCount,
});
const emptyFacts = (): IdentityMergeRiskFacts => Object.fromEntries(
  IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category) => [category, fact()]),
) as unknown as IdentityMergeRiskFacts;

describe('identity merge risk model', () => {
  it('explicitly enumerates every person-bound bearer credential source', () => {
    expect(IDENTITY_MERGE_ACTIVE_CREDENTIAL_SOURCES).toEqual([
      'people.calendar_token',
      'tokens.token_hash',
      'identity_challenges.token_or_code_hash',
      'group_attendance_tokens.token_hash',
      'learning_google_oauth_states.state_hash',
      'learning_canvas_oauth_states.state_hash',
      'identity_recovery_holds.veto_token_hash',
    ]);
  });
  it('hashes the complete safe fact vocabulary and never unions privilege', async () => {
    const state = await buildIdentityMergeRiskState({
      privilegedCategories: ['finance'],
      facts: { ...emptyFacts(), privilege: fact(1) },
    });
    expect(state.hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(classifyIdentityMergeRisk(state)).resolves.toEqual({
      level: 'critical',
      reasons: ['present:privilege'],
      requiredApprovals: 2,
      privilegePolicy: 'canonical_only',
    });
  });

  it('includes presence and collisions for every sensitive/unique domain', async () => {
    const facts = emptyFacts();
    const state = await buildIdentityMergeRiskState({
      privilegedCategories: [],
      facts: {
        ...facts,
        person_interest: fact(1, 1, 1),
        event_admin: fact(1),
        stripe_recurring: fact(1, 0, 1),
      },
    });
    const risk = await classifyIdentityMergeRisk(state);
    expect(risk.level).toBe('critical');
    expect(risk.reasons).toEqual([
      'present:stripe_recurring', 'collision:stripe_recurring',
      'present:person_interest', 'collision:person_interest', 'present:event_admin',
    ]);
    expect(JSON.stringify(risk)).not.toContain('@');
  });

  it('rejects missing, unknown, fractional and tampered facts', async () => {
    await expect(buildIdentityMergeRiskState({
      privilegedCategories: [],
      facts: { ...emptyFacts(), event_admin: { ...fact(), loserCount: 1.5, presenceCount: 1.5 } },
    })).rejects.toThrow(/count/);
    const missing = { ...emptyFacts() } as Record<string, unknown>; delete missing.person_interest;
    await expect(buildIdentityMergeRiskState({ privilegedCategories: [], facts: missing as IdentityMergeRiskFacts }))
      .rejects.toThrow(/missing/);
    const state = await buildIdentityMergeRiskState({ privilegedCategories: [], facts: emptyFacts() });
    await expect(classifyIdentityMergeRisk({ ...state, hash: '0'.repeat(64) })).rejects.toThrow(/hash/);
  });

  it('binds every fact to loser and canonical direction', async () => {
    const loserState = await buildIdentityMergeRiskState({
      privilegedCategories: ['finance'], facts: { ...emptyFacts(), privilege: fact(1, 0) },
    });
    const canonicalState = await buildIdentityMergeRiskState({
      privilegedCategories: ['finance'], facts: { ...emptyFacts(), privilege: fact(0, 1) },
    });
    expect(loserState.hash).not.toBe(canonicalState.hash);
    await expect(buildIdentityMergeRiskState({
      privilegedCategories: [],
      facts: { ...emptyFacts(), contact_link: { ...fact(1, 0), presenceCount: 2 } },
    })).rejects.toThrow(/sum/);
  });

  it('derives the exact required conflict-decision categories', async () => {
    const state = await buildIdentityMergeRiskState({
      privilegedCategories: ['finance'],
      facts: {
        ...emptyFacts(),
        privilege: fact(1),
        verified_contact_owner: fact(0, 1),
        campus_membership: fact(1, 0),
        canonical_key: fact(1, 1, 1),
        active_credential: fact(1),
      },
    });
    await expect(requiredIdentityMergeDecisions(state)).resolves.toEqual([
      'campus_membership', 'contact_owner', 'privilege', 'unique_collision',
    ]);
  });
});

describe('identity merge preview snapshots', () => {
  async function input() {
    const riskState = await buildIdentityMergeRiskState({
      privilegedCategories: [],
      facts: { ...emptyFacts(), contact_link: fact(2, 1, 1) },
    });
    const resolutionCase = await buildIdentityMergeResolutionCaseBinding({
      caseId: 91, caseVersion: 4, campusId: 1, personAId: 82, personBId: 19, state: 'same_person',
    });
    return {
      loser: { personId: 82, identityVersion: 4, sessionEpoch: 2 },
      canonical: { personId: 19, identityVersion: 7, sessionEpoch: 5 },
      resolutionCase,
      scope: { kind: 'campus' as const, campusId: 1 },
      riskState,
      counts: { contact_links: 3, gifts: 4, active_credentials: 1 },
      decisions: { contact_owner: 'manual_required' as const, privilege: 'canonical_only' as const },
      expiresAt: '2030-01-02T03:04:05.000Z',
    };
  }

  it('hashes canonical JSON and binds case plus risk-state hashes', async () => {
    const value = await input();
    const first = await buildIdentityMergePreviewSnapshot(value);
    const second = await buildIdentityMergePreviewSnapshot({
      ...value,
      counts: { gifts: 4, active_credentials: 1, contact_links: 3 },
      decisions: { privilege: 'canonical_only', contact_owner: 'manual_required' },
    });
    expect(first).toEqual(second);
    expect(first.risk).toBe('high');
    expect(first.requiredApprovals).toBe(2);
    expect(await hashIdentityMergePreview(first)).toBe(await hashIdentityMergePreview(second));
  });

  it('excludes raw payload carriers and forbids privilege union', async () => {
    const value = await input();
    const snapshot = await buildIdentityMergePreviewSnapshot(value);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['gift_amount', 'note_body', 'answer', 'provider_payload', 'email', 'phone']) {
      expect(serialized).not.toContain(forbidden);
    }
    await expect(buildIdentityMergePreviewSnapshot({
      ...value, decisions: { privilege: 'keep_both' } as never,
    })).rejects.toThrow(/canonical_only/);
    await expect(buildIdentityMergePreviewSnapshot({
      ...value, counts: { gift_amount: 25 } as never,
    })).rejects.toThrow(/count category/);
  });

  it('rejects identity, case, risk-state, preview hash, version, and time drift', async () => {
    const value = await input();
    const snapshot = await buildIdentityMergePreviewSnapshot(value);
    const previewHash = await hashIdentityMergePreview(snapshot);
    const current = {
      loser: value.loser, canonical: value.canonical, resolutionCase: value.resolutionCase,
      riskState: value.riskState, previewHash, now: '2030-01-02T03:00:00.000Z',
    };
    await expect(assertIdentityMergePreviewFresh(snapshot, current)).resolves.toBeUndefined();
    await expect(assertIdentityMergePreviewFresh(snapshot, {
      ...current, loser: { ...value.loser, identityVersion: 5 },
    })).rejects.toThrow(/stale/);
    const changedCase = await buildIdentityMergeResolutionCaseBinding({
      caseId: 91, caseVersion: 5, campusId: 1, personAId: 82, personBId: 19, state: 'same_person',
    });
    await expect(assertIdentityMergePreviewFresh(snapshot, { ...current, resolutionCase: changedCase })).rejects.toThrow(/stale/);
    const changedRisk = await buildIdentityMergeRiskState({
      privilegedCategories: [], facts: { ...emptyFacts(), person_interest: fact(1) },
    });
    await expect(assertIdentityMergePreviewFresh(snapshot, { ...current, riskState: changedRisk })).rejects.toThrow(/stale/);
    await expect(assertIdentityMergePreviewFresh(snapshot, { ...current, previewHash: '0'.repeat(64) })).rejects.toThrow(/hash/);
    await expect(assertIdentityMergePreviewFresh({ ...snapshot, previewVersion: 2 } as never, current)).rejects.toThrow(/version/);
    await expect(assertIdentityMergePreviewFresh(snapshot, { ...current, now: snapshot.expiresAt })).rejects.toThrow(/expired/);
    await expect(assertIdentityMergePreviewFresh(snapshot, { ...current, now: 'not-a-time' })).rejects.toThrow(/current time/);
  });

  it('binds the exact resolution-case campus into the case and campus-scoped preview', async () => {
    const value = await input();
    const otherCampus = await buildIdentityMergeResolutionCaseBinding({
      caseId: 91, caseVersion: 4, campusId: 2, personAId: 82, personBId: 19, state: 'same_person',
    });
    expect(otherCampus.hash).not.toBe(value.resolutionCase.hash);
    expect(value.resolutionCase.bindingVersion).toBe(2);
    await expect(buildIdentityMergePreviewSnapshot({ ...value, resolutionCase: otherCampus }))
      .rejects.toThrow(/campus mismatch/);
  });
});
