import type { AppDb } from './appDb';
import { hasIdentityControlCharacters, normalizeEmail, normalizeName, normalizePhone, type PhoneNormalizationOptions } from './identityNormalize';
import { resolveIdentity, type IdentityCandidate } from './identityResolution';

export type IdentityContactKind = 'email' | 'phone';
export type VerifiedOwner = {
  personId: number;
  contactPointId: number;
  kind: IdentityContactKind;
  normalizedValue: string;
  displayValue: string;
  /** Legacy compatibility only; delivery must always use the contact point. */
  legacyEmail: string;
};
export type ContactPoint = { id: number; kind: IdentityContactKind; normalizedValue: string; displayValue: string };

function id(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }

export function normalizeIdentityContact(kind: IdentityContactKind, value: string, phone?: PhoneNormalizationOptions): string | null {
  return kind === 'email' ? normalizeEmail(value) : normalizePhone(value, phone);
}

export async function upsertContactPoint(db: AppDb, input: {
  kind: IdentityContactKind; value: string; displayValue?: string; phone?: PhoneNormalizationOptions;
}): Promise<ContactPoint> {
  const normalized = normalizeIdentityContact(input.kind, input.value, input.phone);
  if (!normalized) throw new Error('identity_contact_invalid');
  const display = input.displayValue?.trim() || input.value.trim();
  if (!display || display.length > 512 || hasIdentityControlCharacters(input.value) || hasIdentityControlCharacters(input.displayValue ?? input.value)) throw new Error('identity_contact_invalid');
  try {
    const inserted = await db.prepare(`INSERT INTO contact_points(kind,normalized_value,display_value)
      VALUES(?1,?2,?3) ON CONFLICT(kind,normalized_value) DO UPDATE SET display_value=contact_points.display_value
      RETURNING id,kind,normalized_value,display_value`).bind(input.kind, normalized, display).first<{
        id: number; kind: IdentityContactKind; normalized_value: string; display_value: string;
      }>();
    if (!inserted) throw new Error('identity_contact_write_failed');
    return { id: inserted.id, kind: inserted.kind, normalizedValue: inserted.normalized_value, displayValue: inserted.display_value };
  } catch { throw new Error('identity_contact_write_failed'); }
}

export async function ensureActivePersonContactLink(db: AppDb, input: {
  personId: number; contactPointId: number; kind: IdentityContactKind; source: string; label?: string | null;
  notificationEnabled?: boolean;
}): Promise<void> {
  if (!id(input.personId) || !id(input.contactPointId) || !/^[a-z0-9_-]{1,64}$/i.test(input.source)) throw new Error('identity_link_invalid');
  await db.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,label,notification_enabled)
    VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING`).bind(input.personId, input.contactPointId, input.kind, input.source,
    input.label ?? null, input.notificationEnabled === false ? 0 : 1).run();
  const active = await db.prepare(`SELECT 1 AS ok FROM person_contact_links
    WHERE person_id=?1 AND contact_point_id=?2 AND kind=?3 AND ended_at IS NULL`).bind(input.personId, input.contactPointId, input.kind).first<{ ok: number }>();
  if (!active) throw new Error('identity_link_write_failed');
}

/** Returns only an eligible verified identity owner. This intentionally does not use people.email for delivery. */
export async function findVerifiedContactOwner(db: AppDb, input: {
  kind: IdentityContactKind; value: string; phone?: PhoneNormalizationOptions;
}): Promise<VerifiedOwner | null> {
  const normalized = normalizeIdentityContact(input.kind, input.value, input.phone);
  if (!normalized) return null;
  const row = await db.prepare(`SELECT p.id person_id,p.email legacy_email,c.id contact_point_id,c.kind,c.normalized_value,c.display_value
    FROM contact_points c JOIN verified_contact_owners o ON o.contact_point_id=c.id
    JOIN people p ON p.id=o.person_id
    JOIN person_contact_links l ON l.person_id=p.id AND l.contact_point_id=c.id AND l.kind=c.kind AND l.ended_at IS NULL
    LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
    WHERE c.kind=?1 AND c.normalized_value=?2 AND p.deleted_at IS NULL AND p.active=1
      AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`).bind(input.kind, normalized).first<{
        person_id: number; legacy_email: string; contact_point_id: number; kind: IdentityContactKind; normalized_value: string; display_value: string;
      }>();
  return row ? { personId: row.person_id, contactPointId: row.contact_point_id, kind: row.kind,
    normalizedValue: row.normalized_value, displayValue: row.display_value, legacyEmail: row.legacy_email } : null;
}

export function validateIdentityAuditMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const metadata = value as Record<string, unknown>;
  const allowed = new Set(['challengeId', 'signalCount', 'signals', 'candidateCount', 'priorOwnerId', 'previousOwnerId', 'targetOwnerId', 'transfer', 'reasonCategory']);
  const signalValues = new Set(['verified_owner', 'unique_verified_contact_owner', 'shared_or_unverified_contact', 'trusted_external_identity', 'name_and_dob_similarity', 'name_and_household_similarity', 'name_only_similarity', 'insufficient_evidence', 'conflicting_dob', 'conflicting_verified_external_identity']);
  const reasonValues = new Set(['admin_review', 'external_verified', 'verified_email', 'unspecified']);
  if (Object.keys(metadata).length > allowed.size || Object.keys(metadata).some((key) => !allowed.has(key))) return null;
  for (const [key, item] of Object.entries(metadata)) {
    if (['challengeId', 'signalCount', 'candidateCount', 'priorOwnerId', 'previousOwnerId', 'targetOwnerId'].includes(key)) {
      if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 2_147_483_647) return null;
    } else if (key === 'transfer') {
      if (typeof item !== 'boolean') return null;
    } else if (key === 'reasonCategory') {
      if (typeof item !== 'string' || !reasonValues.has(item)) return null;
    } else if (key === 'signals') {
      if (!Array.isArray(item) || item.length > 16 || !item.every((entry) => typeof entry === 'string' && signalValues.has(entry))) return null;
    }
  }
  return Object.freeze({ ...metadata });
}

export async function assignVerifiedContactOwner(db: AppDb, input: {
  campusId: number; contactPointId: number; personId: number; transfer?: boolean;
  proof: { kind: 'admin'; actorPersonId: number; reasonCode: 'admin_review' }
    | { kind: 'external'; actorPersonId: number; provider: string; organizationId: string; externalPersonId: string; reasonCode: 'external_verified' }
    | { kind: 'challenge'; publicId: string; purpose: 'claim' | 'contact_change'; reasonCode: 'verified_email' };
}): Promise<void> {
  if (!id(input.campusId) || !id(input.contactPointId) || !id(input.personId) || !input.proof) throw new Error('identity_owner_proof_required');
  let method: 'legacy_unique' | 'email_link' | 'admin_review' | 'external_provider' = 'admin_review'; let challengeId: number | null = null;
  let challengePersonId: number | null = null;
  if (input.proof.kind === 'challenge') {
    const challenge = await db.prepare(`SELECT id,person_id FROM identity_challenges WHERE public_id=?1 AND campus_id=?2 AND contact_point_id=?3
      AND purpose=?4 AND consumed_at IS NOT NULL AND superseded_at IS NULL AND ownership_consumed_at IS NULL`).bind(input.proof.publicId, input.campusId, input.contactPointId, input.proof.purpose).first<{ id: number; person_id: number | null }>();
    if (!challenge) throw new Error('identity_owner_proof_invalid');
    challengeId = challenge.id; challengePersonId = challenge.person_id; method = 'email_link';
    if (input.proof.purpose === 'claim' && challengePersonId === null) throw new Error('identity_owner_review_required');
    if (challengePersonId !== input.personId) throw new Error('identity_owner_proof_invalid');
  } else if (!id(input.proof.actorPersonId)) throw new Error('identity_owner_proof_invalid');
  else {
    const actor = await db.prepare(`SELECT 1 AS ok FROM people WHERE id=?1 AND active=1 AND deleted_at IS NULL AND identity_state='active'
      AND auth_disabled_at IS NULL AND role='admin' AND super_admin=1`).bind(input.proof.actorPersonId).first<{ ok: number }>();
    if (!actor) throw new Error('identity_owner_proof_invalid');
    if (input.proof.kind === 'external') {
      const mapped = await db.prepare(`SELECT 1 AS ok FROM person_external_identities WHERE person_id=?1 AND provider=?2 AND organization_id=?3
        AND external_person_id=?4 AND verified_at IS NOT NULL`).bind(input.personId, input.proof.provider, input.proof.organizationId, input.proof.externalPersonId).first<{ ok: number }>();
      if (!mapped) throw new Error('identity_owner_proof_invalid');
    }
    method = input.proof.kind === 'external' ? 'external_provider' : 'admin_review';
  }
  const eligible = await db.prepare(`SELECT 1 AS ok FROM people p JOIN person_contact_links l ON l.person_id=p.id JOIN contact_points c ON c.id=l.contact_point_id AND c.kind=l.kind
    WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
      AND l.contact_point_id=?2 AND l.ended_at IS NULL`).bind(input.personId, input.contactPointId).first<{ ok: number }>();
  if (!eligible) throw new Error('identity_owner_ineligible');
  const state = await db.prepare(`SELECT
    (SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?1) AS person_id,
    COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims WHERE contact_point_id=?1),0) AS generation`)
    .bind(input.contactPointId).first<{ person_id: number | null; generation: number }>();
  if (!state) throw new Error('identity_owner_mutation_unavailable');
  const prior = state.person_id === null ? null : { person_id: state.person_id };
  if (prior?.person_id === input.personId && challengeId === null) return; // trusted operations are idempotent
  if (input.proof.kind === 'challenge' && ((input.proof.purpose === 'claim' && prior) || Boolean(prior && prior.person_id !== input.personId))) throw new Error('identity_owner_proof_invalid');
  if (prior && !input.transfer) throw new Error('identity_owner_transfer_required');
  const reasonCode = input.proof.reasonCode;
  const actorPersonId = input.proof.kind === 'challenge' ? null : input.proof.actorPersonId;
  const metadata = validateIdentityAuditMetadata({ priorOwnerId: prior?.person_id ?? 0, transfer: Boolean(prior), reasonCategory: reasonCode ?? 'unspecified' });
  if (!metadata) throw new Error('identity_audit_invalid');
  const statements = [db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
    VALUES(?1,?2,?3,?4,?5)`).bind(input.contactPointId, state.generation + 1, prior?.person_id ?? null, input.personId, prior ? 'transfer' : 'assign')];
  if (input.proof.kind === 'challenge' && challengeId !== null) statements.push(db.prepare(`INSERT INTO identity_challenge_proof_uses(challenge_id,contact_point_id,person_id,purpose,proof_category)
    VALUES(?1,?2,?3,?4,'email_challenge')`).bind(challengeId, input.contactPointId, input.personId, input.proof.purpose));
  if (prior) {
    statements.push(db.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1 AND person_id=?2').bind(input.contactPointId, prior.person_id));
    statements.push(db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,previous_person_id,event_type,actor_person_id,reason)
      VALUES(?1,NULL,?2,'revoked',?3,NULL)`).bind(input.contactPointId, prior.person_id, actorPersonId));
  }
  statements.push(db.prepare(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method,challenge_id)
    VALUES(?1,?2,?3,?4)`).bind(input.contactPointId, input.personId, method, challengeId));
  statements.push(db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,previous_person_id,event_type,actor_person_id,reason)
    VALUES(?1,?2,?3,?4,?5,NULL)`).bind(input.contactPointId, input.personId, prior?.person_id ?? null,
    prior ? 'transferred' : 'verified', actorPersonId));
  statements.push(db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,actor_person_id,subject_person_id,contact_point_id,metadata_json)
    VALUES(?1,?2,?3,?4,?5,?6)`).bind(input.campusId, prior ? 'contact_owner_transferred' : 'contact_owner_verified', actorPersonId, input.personId, input.contactPointId, JSON.stringify(metadata)));
  if (challengeId !== null) statements.push(db.prepare('UPDATE identity_challenges SET ownership_consumed_at=datetime(\'now\') WHERE id=?1 AND ownership_consumed_at IS NULL').bind(challengeId));
  try { await db.batch(statements); }
  catch (error) {
    if (String(error).includes('contact_owner_mutation_conflict') || String(error).includes('UNIQUE constraint') || String(error).includes('unique constraint')) {
      throw new Error('identity_owner_mutation_conflict');
    }
    throw error;
  }
}

export async function revokeVerifiedContactOwner(db: AppDb, input: { campusId: number; contactPointId: number; proof: { kind: 'admin'; actorPersonId: number; reasonCode: 'admin_review' } }): Promise<boolean> {
  if (!input.proof || !id(input.proof.actorPersonId)) throw new Error('identity_owner_proof_required');
  const actor = await db.prepare(`SELECT 1 AS ok FROM people WHERE id=?1 AND active=1 AND deleted_at IS NULL AND identity_state='active'
    AND auth_disabled_at IS NULL AND role='admin' AND super_admin=1`).bind(input.proof.actorPersonId).first<{ ok: number }>();
  if (!actor) throw new Error('identity_owner_proof_invalid');
  const state = await db.prepare(`SELECT
    (SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?1) AS person_id,
    COALESCE((SELECT MAX(generation) FROM contact_owner_mutation_claims WHERE contact_point_id=?1),0) AS generation`)
    .bind(input.contactPointId).first<{ person_id: number | null; generation: number }>();
  if (!state || state.person_id === null) return false;
  const prior = { person_id: state.person_id };
  const metadata = validateIdentityAuditMetadata({ previousOwnerId: prior.person_id, reasonCategory: input.proof.reasonCode });
  if (!metadata) throw new Error('identity_audit_invalid');
  try { await db.batch([
    db.prepare(`INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation)
      VALUES(?1,?2,?3,NULL,'revoke')`).bind(input.contactPointId, state.generation + 1, prior.person_id),
    db.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1 AND person_id=?2').bind(input.contactPointId, prior.person_id),
    db.prepare(`INSERT INTO contact_ownership_events(contact_point_id,person_id,previous_person_id,event_type,actor_person_id,reason)
      VALUES(?1,NULL,?2,'revoked',?3,NULL)`).bind(input.contactPointId, prior.person_id, input.proof.actorPersonId),
    db.prepare(`INSERT INTO identity_audit_events(campus_id,event_type,actor_person_id,subject_person_id,contact_point_id,metadata_json)
      VALUES(?1,'contact_owner_revoked',?2,?3,?4,?5)`).bind(input.campusId, input.proof.actorPersonId, prior.person_id, input.contactPointId, JSON.stringify(metadata)),
  ]); } catch (error) {
    if (String(error).includes('contact_owner_mutation_conflict') || String(error).includes('UNIQUE constraint') || String(error).includes('unique constraint')) return false;
    throw error;
  }
  return true;
}

export async function resolveCanonicalPerson(db: AppDb, personId: number): Promise<number | null> {
  if (!id(personId)) return null;
  const redirect = await db.prepare('SELECT canonical_person_id FROM person_merge_redirects WHERE loser_person_id=?1').bind(personId).first<{ canonical_person_id: number }>();
  return redirect?.canonical_person_id ?? personId;
}

export type IdentityObservationCandidate = Pick<IdentityCandidate,
  'personId' | 'nameSimilarity' | 'dateOfBirthMatch' | 'householdSimilarity' | 'conflictingDob'>;

export type ObservedExternalIdentity = {
  provider: string;
  organizationId: string;
  externalPersonId: string;
};

const OBSERVATION_SOURCES = new Set(['signup', 'giving', 'registration', 'group', 'team', 'newcomer', 'import', 'planning_center']);

function validObservedExternalIdentity(value: unknown): value is ObservedExternalIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.provider === 'string' && identity.provider.length >= 1 && identity.provider.length <= 64
    && typeof identity.organizationId === 'string' && identity.organizationId.length >= 1 && identity.organizationId.length <= 255
    && typeof identity.externalPersonId === 'string' && identity.externalPersonId.length >= 1 && identity.externalPersonId.length <= 255
    && !hasIdentityControlCharacters(identity.provider)
    && !hasIdentityControlCharacters(identity.organizationId)
    && !hasIdentityControlCharacters(identity.externalPersonId);
}

function mergeContactEvidence(current: IdentityCandidate['exactContact'], next: NonNullable<IdentityCandidate['exactContact']>): NonNullable<IdentityCandidate['exactContact']> {
  const rank = { verified_owner: 1, unverified: 2, shared: 3 } as const;
  return current && rank[current] >= rank[next] ? current : next;
}

async function deriveObservationEvidence(db: AppDb, input: {
  campusId: number;
  email: string | null;
  phone: string | null;
  candidates: IdentityObservationCandidate[];
  externalIdentity?: ObservedExternalIdentity;
}): Promise<{ candidates: IdentityCandidate[]; externalIdentity?: { personId: number; trusted: true; exact: true; conflicts?: boolean } }> {
  const candidates = new Map<number, IdentityCandidate>();
  const verifiedContactOwnerIds = new Set<number>();
  for (const supplied of input.candidates) {
    if (!supplied || typeof supplied !== 'object' || !id(supplied.personId)) throw new Error('identity_observation_invalid');
    const eligible = await db.prepare(`SELECT p.id FROM people p LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      WHERE p.id=?1 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
        AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL`).bind(supplied.personId).first<{ id: number }>();
    if (!eligible) continue;
    const prior = candidates.get(supplied.personId);
    candidates.set(supplied.personId, {
      personId: supplied.personId,
      nameSimilarity: prior?.nameSimilarity || supplied.nameSimilarity === true,
      dateOfBirthMatch: prior?.dateOfBirthMatch || supplied.dateOfBirthMatch === true,
      householdSimilarity: prior?.householdSimilarity || supplied.householdSimilarity === true,
      conflictingDob: prior?.conflictingDob || supplied.conflictingDob === true,
    });
  }

  for (const [kind, normalizedValue] of [['email', input.email], ['phone', input.phone]] as const) {
    if (!normalizedValue) continue;
    const rows = (await db.prepare(`SELECT c.id contact_point_id,l.person_id,o.person_id owner_person_id,
        CASE WHEN EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=?3 AND h.contact_point_id=c.id AND h.ended_at IS NULL) THEN 1 ELSE 0 END household_shared
        ,CASE WHEN p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL THEN 1 ELSE 0 END eligible
      FROM contact_points c JOIN person_contact_links l ON l.contact_point_id=c.id AND l.kind=c.kind AND l.ended_at IS NULL
      JOIN people p ON p.id=l.person_id LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      LEFT JOIN verified_contact_owners o ON o.contact_point_id=c.id
      WHERE c.kind=?1 AND c.normalized_value=?2
      ORDER BY l.person_id`).bind(kind, normalizedValue, input.campusId).all<{
        contact_point_id: number; person_id: number; owner_person_id: number | null; household_shared: number; eligible: number;
      }>()).results;
    if (!rows.length) continue;
    for (const row of rows) if (row.owner_person_id === row.person_id && row.eligible === 1) verifiedContactOwnerIds.add(row.person_id);
    const shared = rows.length !== 1 || rows.some((row) => row.household_shared === 1);
    for (const row of rows) {
      if (row.eligible !== 1) continue;
      const prior = candidates.get(row.person_id) ?? { personId: row.person_id };
      const evidence = shared ? 'shared' : row.owner_person_id === row.person_id ? 'verified_owner' : 'unverified';
      prior.exactContact = mergeContactEvidence(prior.exactContact, evidence);
      candidates.set(row.person_id, prior);
    }
  }

  let externalIdentity: { personId: number; trusted: true; exact: true; conflicts?: boolean } | undefined;
  if (input.externalIdentity) {
    const mapped = await db.prepare(`SELECT x.person_id FROM person_external_identities x JOIN people p ON p.id=x.person_id
      LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
      WHERE x.provider=?1 AND x.organization_id=?2 AND x.external_person_id=?3 AND x.verified_at IS NOT NULL
        AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active' AND p.auth_disabled_at IS NULL
        AND r.loser_person_id IS NULL`).bind(input.externalIdentity.provider, input.externalIdentity.organizationId,
      input.externalIdentity.externalPersonId).first<{ person_id: number }>();
    if (mapped) {
      if (!candidates.has(mapped.person_id)) candidates.set(mapped.person_id, { personId: mapped.person_id });
      const verifiedOwners = [...candidates.values()].filter((candidate) => candidate.exactContact === 'verified_owner');
      externalIdentity = { personId: mapped.person_id, trusted: true, exact: true,
        conflicts: verifiedOwners.some((candidate) => candidate.personId !== mapped.person_id)
          || [...verifiedContactOwnerIds].some((personId) => personId !== mapped.person_id) || undefined };
    }
  }
  return { candidates: [...candidates.values()], externalIdentity };
}

export async function upsertIdentityObservation(db: AppDb, input: {
  campusId: number; source: 'signup' | 'giving' | 'registration' | 'group' | 'team' | 'newcomer' | 'import' | 'planning_center'; sourceKey: string;
  email?: string | null; phone?: string | null; name?: string | null; candidates: IdentityObservationCandidate[]; externalIdentity?: ObservedExternalIdentity;
}): Promise<{ observationId: number; outcome: ReturnType<typeof resolveIdentity>['outcome']; caseIds: number[] }> {
  const email = input.email == null ? null : normalizeEmail(input.email);
  const phone = input.phone == null ? null : normalizePhone(input.phone);
  const externalIdentity = input.externalIdentity === undefined ? undefined
    : validObservedExternalIdentity(input.externalIdentity) ? input.externalIdentity : null;
  const candidatesValid = Array.isArray(input.candidates) && input.candidates.length <= 100
    && input.candidates.every((candidate) => candidate && typeof candidate === 'object' && id(candidate.personId));
  if ((input.email != null && !email) || (input.phone != null && !phone) || !id(input.campusId)
    || typeof input.sourceKey !== 'string' || !input.sourceKey || input.sourceKey.length > 255
    || hasIdentityControlCharacters(input.sourceKey) || !OBSERVATION_SOURCES.has(input.source)
    || !candidatesValid || externalIdentity === null) throw new Error('identity_observation_invalid');
  const name = input.name == null ? null : normalizeName(input.name);
  if (input.name != null && !name) throw new Error('identity_observation_invalid');
  const acquired = await db.prepare(`INSERT INTO identity_observations(campus_id,source,source_key,normalized_email,normalized_phone,normalized_name)
    VALUES(?1,?2,?3,?4,?5,?6)
    ON CONFLICT(campus_id,source,source_key) DO UPDATE SET source_key=identity_observations.source_key
      WHERE COALESCE(identity_observations.normalized_email,'')=COALESCE(excluded.normalized_email,'')
        AND COALESCE(identity_observations.normalized_phone,'')=COALESCE(excluded.normalized_phone,'')
        AND COALESCE(identity_observations.normalized_name,'')=COALESCE(excluded.normalized_name,'')
    RETURNING id`).bind(input.campusId, input.source, input.sourceKey, email, phone, name).first<{ id: number }>();
  if (!acquired) throw new Error('identity_observation_payload_drift');
  const observationId = acquired.id;
  const evidence = await deriveObservationEvidence(db, { campusId: input.campusId, email, phone, candidates: input.candidates, externalIdentity: externalIdentity ?? undefined });
  const resolution = resolveIdentity(evidence);
  const status = resolution.outcome === 'matched' ? 'linked'
    : resolution.outcome === 'review' ? 'review'
      : resolution.outcome === 'blocked' ? 'dismissed' : 'provisional';
  const matchedPersonId = resolution.outcome === 'matched' && id(resolution.personId) ? resolution.personId : null;
  const externalMatch = matchedPersonId !== null && resolution.signals.includes('trusted_external_identity') && externalIdentity;
  const contactMatch = matchedPersonId !== null && resolution.signals.includes('unique_verified_contact_owner');
  let matchedPredicate = '0=1'; let matchedBindings: unknown[] = [];
  if (externalMatch) {
    matchedPredicate = `EXISTS (SELECT 1 FROM people p LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
        WHERE p.id=?2 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
          AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL)
      AND EXISTS (SELECT 1 FROM person_external_identities x WHERE x.person_id=?2 AND x.provider=?3
        AND x.organization_id=?4 AND x.external_person_id=?5 AND x.verified_at IS NOT NULL)`;
    matchedBindings = [observationId, matchedPersonId, externalMatch.provider, externalMatch.organizationId, externalMatch.externalPersonId];
  } else if (contactMatch) {
    matchedPredicate = `EXISTS (SELECT 1 FROM people p LEFT JOIN person_merge_redirects r ON r.loser_person_id=p.id
        WHERE p.id=?2 AND p.active=1 AND p.deleted_at IS NULL AND p.identity_state='active'
          AND p.auth_disabled_at IS NULL AND r.loser_person_id IS NULL)
      AND EXISTS (SELECT 1 FROM contact_points c JOIN verified_contact_owners o ON o.contact_point_id=c.id
        JOIN person_contact_links l ON l.contact_point_id=c.id AND l.kind=c.kind AND l.person_id=?2 AND l.ended_at IS NULL
        WHERE ((?4 IS NOT NULL AND c.kind='email' AND c.normalized_value=?4)
          OR (?5 IS NOT NULL AND c.kind='phone' AND c.normalized_value=?5)) AND o.person_id=?2
          AND NOT EXISTS (SELECT 1 FROM person_contact_links other WHERE other.contact_point_id=c.id AND other.ended_at IS NULL AND other.person_id<>?2)
          AND NOT EXISTS (SELECT 1 FROM household_contact_links h WHERE h.campus_id=?3 AND h.contact_point_id=c.id AND h.ended_at IS NULL))`;
    matchedBindings = [observationId, matchedPersonId, input.campusId, email, phone];
  }
  const writes = matchedPersonId === null
    ? [db.prepare(`UPDATE identity_observations SET status=?1,linked_person_id=NULL,updated_at=datetime('now') WHERE id=?2`).bind(status, observationId)]
    : [db.prepare(`UPDATE identity_observations SET
        status=CASE WHEN ${matchedPredicate} THEN 'linked' ELSE 'provisional' END,
        linked_person_id=CASE WHEN ${matchedPredicate} THEN ?2 ELSE NULL END,
        updated_at=datetime('now') WHERE id=?1`).bind(...matchedBindings)];
  if (resolution.outcome === 'review') {
    const candidateIds = evidence.candidates.map((candidate) => candidate.personId);
    const stalePredicate = candidateIds.length
      ? `candidate_person_id NOT IN (${candidateIds.map((_, index) => `?${index + 3}`).join(',')})`
      : '1=1';
    writes.push(db.prepare(`UPDATE identity_resolution_cases SET state='dismissed',resolution='evidence_changed',resolved_at=datetime('now')
      WHERE campus_id=?1 AND observation_id=?2 AND state='open' AND ${stalePredicate}`).bind(input.campusId, observationId, ...candidateIds));
    for (const candidate of evidence.candidates) writes.push(db.prepare(`INSERT INTO identity_resolution_cases(campus_id,observation_id,candidate_person_id,score,evidence_json,risk)
      VALUES(?1,?2,?3,?4,?5,?6)
      ON CONFLICT(campus_id,observation_id,candidate_person_id) WHERE state='open'
      DO UPDATE SET score=excluded.score,evidence_json=excluded.evidence_json,risk=excluded.risk`).bind(input.campusId, observationId, candidate.personId,
      resolution.score, JSON.stringify({ signals: resolution.signals, candidateCount: evidence.candidates.length }), resolution.score >= 60 ? 'high' : 'normal'));
  }
  else writes.push(db.prepare(`UPDATE identity_resolution_cases SET state='dismissed',resolution='evidence_changed',resolved_at=datetime('now')
    WHERE campus_id=?1 AND observation_id=?2 AND state='open'`).bind(input.campusId, observationId));
  await db.batch(writes);
  let finalOutcome = resolution.outcome;
  if (resolution.outcome === 'matched') {
    const persisted = await db.prepare('SELECT status,linked_person_id FROM identity_observations WHERE id=?1').bind(observationId)
      .first<{ status: string; linked_person_id: number | null }>();
    if (!persisted || persisted.status !== 'linked' || persisted.linked_person_id !== matchedPersonId) finalOutcome = 'provisional';
  }
  const caseIds = finalOutcome === 'review'
    ? (await db.prepare(`SELECT id FROM identity_resolution_cases WHERE campus_id=?1 AND observation_id=?2 AND state='open' ORDER BY id`)
      .bind(input.campusId, observationId).all<{ id: number }>()).results.map((row) => row.id)
    : [];
  return { observationId, outcome: finalOutcome, caseIds };
}
