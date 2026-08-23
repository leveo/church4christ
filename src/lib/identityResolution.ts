export type IdentityCandidate = {
  personId: number;
  /** A currently verified owner is the only contact state eligible for an automatic match. */
  exactContact?: 'verified_owner' | 'shared' | 'unverified';
  nameSimilarity?: boolean;
  dateOfBirthMatch?: boolean;
  householdSimilarity?: boolean;
  conflictingDob?: boolean;
  conflictingVerifiedExternalIdentity?: boolean;
};

export type IdentityResolutionInput = {
  externalIdentity?: { personId: number; trusted: boolean; exact: boolean; conflicts?: boolean };
  candidates: IdentityCandidate[];
};

export type IdentityResolution = {
  outcome: 'matched' | 'review' | 'provisional' | 'blocked';
  personId?: number;
  score: number;
  signals: string[];
};

/**
 * A deliberately conservative, deterministic policy. It reports the evidence
 * that led to the disposition so routes can persist an auditable case without
 * reimplementing matching rules.
 */
export function resolveIdentity(input: IdentityResolutionInput): IdentityResolution {
  if (input.externalIdentity?.conflicts) {
    return { outcome: 'blocked', score: 0, signals: ['conflicting_verified_external_identity'] };
  }
  if (input.candidates.some((candidate) => candidate.conflictingVerifiedExternalIdentity)) {
    return { outcome: 'blocked', score: 0, signals: ['conflicting_verified_external_identity'] };
  }
  if (input.candidates.some((candidate) => candidate.conflictingDob)) {
    return { outcome: 'blocked', score: 0, signals: ['conflicting_dob'] };
  }
  if (input.externalIdentity?.trusted && input.externalIdentity.exact) {
    return {
      outcome: 'matched', personId: input.externalIdentity.personId, score: 100,
      signals: ['trusted_external_identity'],
    };
  }

  const verifiedOwners = input.candidates.filter((candidate) => candidate.exactContact === 'verified_owner');
  if (input.candidates.some((candidate) => candidate.exactContact === 'shared' || candidate.exactContact === 'unverified')) {
    return { outcome: 'review', score: 60, signals: ['shared_or_unverified_contact'] };
  }
  if (verifiedOwners.length === 1) {
    return { outcome: 'matched', personId: verifiedOwners[0].personId, score: 95, signals: ['unique_verified_contact_owner'] };
  }
  if (verifiedOwners.length > 1) {
    return { outcome: 'review', score: 60, signals: ['shared_or_unverified_contact'] };
  }

  const nameAndDob = input.candidates.filter((candidate) => candidate.nameSimilarity && candidate.dateOfBirthMatch);
  if (nameAndDob.length === 1) return { outcome: 'review', personId: nameAndDob[0].personId, score: 55, signals: ['name_and_dob_similarity'] };
  if (nameAndDob.length > 1) return { outcome: 'review', score: 55, signals: ['name_and_dob_similarity'] };
  const nameAndHousehold = input.candidates.filter((candidate) => candidate.nameSimilarity && candidate.householdSimilarity);
  if (nameAndHousehold.length === 1) return { outcome: 'review', personId: nameAndHousehold[0].personId, score: 35, signals: ['name_and_household_similarity'] };
  if (nameAndHousehold.length > 1) return { outcome: 'review', score: 35, signals: ['name_and_household_similarity'] };
  if (input.candidates.some((candidate) => candidate.nameSimilarity)) {
    return { outcome: 'review', score: 20, signals: ['name_only_similarity'] };
  }
  return { outcome: 'provisional', score: 0, signals: ['insufficient_evidence'] };
}
