import { describe, expect, it } from 'vitest';
import { resolveIdentity } from '../src/lib/identityResolution';

describe('identity resolution policy', () => {
  it('auto-matches a trusted exact external identity', () => {
    expect(resolveIdentity({
      externalIdentity: { personId: 12, trusted: true, exact: true },
      candidates: [],
    })).toMatchObject({ outcome: 'matched', personId: 12, score: 100, signals: ['trusted_external_identity'] });
  });

  it('sends shared contacts to review instead of choosing an owner', () => {
    expect(resolveIdentity({
      candidates: [
        { personId: 1, exactContact: 'shared' },
        { personId: 2, exactContact: 'shared' },
      ],
    })).toMatchObject({ outcome: 'review', score: 60, signals: ['shared_or_unverified_contact'] });
  });

  it('auto-matches only one verified contact owner', () => {
    expect(resolveIdentity({ candidates: [{ personId: 5, exactContact: 'verified_owner' }] }))
      .toEqual({ outcome: 'matched', personId: 5, score: 95, signals: ['unique_verified_contact_owner'] });
    expect(resolveIdentity({
      candidates: [
        { personId: 5, exactContact: 'verified_owner' },
        { personId: 6, exactContact: 'verified_owner' },
      ],
    })).toEqual({ outcome: 'review', score: 60, signals: ['shared_or_unverified_contact'] });
  });

  it('forces shared or unverified exact-contact evidence to review even beside one owner', () => {
    expect(resolveIdentity({
      candidates: [
        { personId: 5, exactContact: 'verified_owner' },
        { personId: 6, exactContact: 'shared' },
      ],
    })).toEqual({ outcome: 'review', score: 60, signals: ['shared_or_unverified_contact'] });
    expect(resolveIdentity({
      candidates: [
        { personId: 5, exactContact: 'verified_owner' },
        { personId: 6, exactContact: 'unverified' },
      ],
    })).toEqual({ outcome: 'review', score: 60, signals: ['shared_or_unverified_contact'] });
  });

  it('does not treat an untrusted external identity as a match', () => {
    expect(resolveIdentity({
      externalIdentity: { personId: 5, trusted: false, exact: true }, candidates: [],
    })).toEqual({ outcome: 'provisional', score: 0, signals: ['insufficient_evidence'] });
  });

  it('blocks contradictory DOB or verified external identity evidence', () => {
    expect(resolveIdentity({
      candidates: [{ personId: 1, exactContact: 'verified_owner', conflictingDob: true }],
    })).toMatchObject({ outcome: 'blocked', signals: ['conflicting_dob'] });
    expect(resolveIdentity({
      candidates: [{ personId: 1, exactContact: 'verified_owner', conflictingVerifiedExternalIdentity: true }],
    })).toMatchObject({ outcome: 'blocked', signals: ['conflicting_verified_external_identity'] });
  });

  it('never auto-matches name-only or household similarity', () => {
    expect(resolveIdentity({
      candidates: [{ personId: 9, nameSimilarity: true, householdSimilarity: true }],
    })).toMatchObject({ outcome: 'review', personId: 9, score: 35, signals: ['name_and_household_similarity'] });
  });

  it('routes true name-only evidence to review without choosing a person', () => {
    expect(resolveIdentity({ candidates: [{ personId: 9, nameSimilarity: true }] }))
      .toEqual({ outcome: 'review', score: 20, signals: ['name_only_similarity'] });
  });

  it('does not choose an order-dependent person for tied name similarity evidence', () => {
    const tiedDob = [
      { personId: 11, nameSimilarity: true, dateOfBirthMatch: true },
      { personId: 12, nameSimilarity: true, dateOfBirthMatch: true },
    ] as const;
    expect(resolveIdentity({ candidates: [...tiedDob] })).toEqual({ outcome: 'review', score: 55, signals: ['name_and_dob_similarity'] });
    expect(resolveIdentity({ candidates: [...tiedDob].reverse() })).toEqual({ outcome: 'review', score: 55, signals: ['name_and_dob_similarity'] });
    expect(resolveIdentity({ candidates: tiedDob.map((candidate) => ({ ...candidate, dateOfBirthMatch: false, householdSimilarity: true })) }))
      .toEqual({ outcome: 'review', score: 35, signals: ['name_and_household_similarity'] });
  });

  it('creates a provisional identity when evidence does not identify a person', () => {
    expect(resolveIdentity({ candidates: [] })).toEqual({ outcome: 'provisional', score: 0, signals: ['insufficient_evidence'] });
  });
});
