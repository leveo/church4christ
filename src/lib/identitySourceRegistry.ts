export type IdentitySource = 'giving' | 'registration' | 'group' | 'team' | 'newcomer' | 'import' | 'planning_center';
export type IdentityAttachmentPolicy = 'signed_in_or_claim' | 'observation_only' | 'external_review';

const SOURCE_POLICIES: Readonly<Record<IdentitySource, IdentityAttachmentPolicy>> = Object.freeze({
  giving: 'signed_in_or_claim',
  registration: 'signed_in_or_claim',
  group: 'observation_only',
  team: 'signed_in_or_claim',
  newcomer: 'observation_only',
  import: 'observation_only',
  planning_center: 'external_review',
});

export function isIdentitySource(value: unknown): value is IdentitySource {
  return typeof value === 'string' && Object.hasOwn(SOURCE_POLICIES, value);
}

export function identitySourcePolicy(source: IdentitySource): IdentityAttachmentPolicy {
  if (!isIdentitySource(source)) throw new Error('identity_source_invalid');
  return SOURCE_POLICIES[source];
}

export function assertIdentitySourcePolicy(source: IdentitySource, policy: IdentityAttachmentPolicy): void {
  if (identitySourcePolicy(source) !== policy) throw new Error('identity_source_policy_invalid');
}
