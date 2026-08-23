import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { assignVerifiedContactOwner, ensureActivePersonContactLink, upsertContactPoint } from '../src/lib/identityDb';
import { consumeEmailOtpChallenge, identityTrustedRequestContext } from '../src/lib/identityAuth';
import { beginSignup, completeVerifiedSignup } from '../src/lib/identityAccount';
import {
  attachIdentitySourceForSignedInSession,
  createProvisionalPersonForObservation,
  identityGatewaySessionContext,
  registerIdentitySource,
} from '../src/lib/identityGateway';
import { beginSourceClaim, completeSourceClaim } from '../src/lib/identityClaim';
import { identitySourcePolicy, type IdentitySource } from '../src/lib/identitySourceRegistry';

const authEnv = {
  IDENTITY_VERIFICATION_SECRET: 'identity-source-test-secret-that-is-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_SECRET: 'stable-identity-source-key-secret-that-is-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
};
let sequence = 1_240_000_000;
const next = () => ++sequence;
const digest = (value: string) => value.repeat(64);
const requestContext = () => identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.88' }), `source-${next()}`);

async function person(label: string, campusId = 1) {
  const id = next();
  await env.DB.prepare(`INSERT INTO people(id,display_name,email,role,super_admin,home_campus_id)
    VALUES(?1,?2,?3,'admin',1,?4)`).bind(id, label, `source-person-${id}@example.test`, campusId).run();
  return id;
}

function sourceInput(overrides: Partial<Parameters<typeof registerIdentitySource>[2]> = {}) {
  const key = `record:${next()}`;
  return {
    campusId: 1,
    source: 'giving' as const,
    sourceRecordKey: key,
    email: `source-${sequence}@example.test`,
    name: 'Observed Member',
    attachmentPolicy: 'signed_in_or_claim' as const,
    sourceDigest: digest('a'),
    ...overrides,
  };
}

async function ownedContact(email: string, owner: number, second?: number) {
  const contact = await upsertContactPoint(env.DB, { kind: 'email', value: email });
  await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: contact.id, kind: 'email', source: 'test' });
  if (second) await ensureActivePersonContactLink(env.DB, { personId: second, contactPointId: contact.id, kind: 'email', source: 'test' });
  await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: contact.id, personId: owner,
    proof: { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } });
  return contact;
}

describe('identity source gateway', () => {
  it('uses a frozen static source policy registry and rejects caller-selected policy changes', async () => {
    expect(identitySourcePolicy('giving')).toBe('signed_in_or_claim');
    expect(identitySourcePolicy('registration')).toBe('signed_in_or_claim');
    expect(identitySourcePolicy('team')).toBe('signed_in_or_claim');
    for (const source of ['group', 'newcomer', 'import'] as IdentitySource[]) {
      expect(identitySourcePolicy(source)).toBe('observation_only');
    }
    expect(identitySourcePolicy('planning_center')).toBe('external_review');
    await expect(registerIdentitySource(env.DB, authEnv, sourceInput({ source: 'group', attachmentPolicy: 'signed_in_or_claim' })))
      .rejects.toThrow('identity_source_policy_invalid');
  });

  it('registers idempotently, fails closed on payload drift, and requires an explicit CAS version replacement', async () => {
    const input = sourceInput();
    const first = await registerIdentitySource(env.DB, authEnv, input);
    expect(await registerIdentitySource(env.DB, authEnv, input)).toEqual(first);
    await expect(registerIdentitySource(env.DB, authEnv, { ...input, name: 'Changed Member' }))
      .rejects.toThrow('identity_source_payload_drift');
    await expect(registerIdentitySource(env.DB, authEnv, { ...input, sourceDigest: digest('b') }))
      .rejects.toThrow('identity_source_payload_drift');
    const replaced = await registerIdentitySource(env.DB, authEnv, {
      ...input, name: 'Changed Member', sourceDigest: digest('b'), replaceVersion: { expectedVersion: 1 },
    });
    expect(replaced).toMatchObject({ sourceRecordId: first.sourceRecordId, observationId: first.observationId, version: 2, state: 'unlinked' });
    await expect(registerIdentitySource(env.DB, authEnv, {
      ...input, sourceDigest: digest('c'), replaceVersion: { expectedVersion: 1 },
    })).rejects.toThrow('identity_source_version_conflict');

    const racedInput = sourceInput(); const raced = await registerIdentitySource(env.DB, authEnv, racedInput);
    const replacements = await Promise.allSettled([
      registerIdentitySource(env.DB, authEnv, { ...racedInput, name: 'Race Left', sourceDigest: digest('c'), replaceVersion: { expectedVersion: 1 } }),
      registerIdentitySource(env.DB, authEnv, { ...racedInput, name: 'Race Right', sourceDigest: digest('d'), replaceVersion: { expectedVersion: 1 } }),
    ]);
    expect(replacements.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const persisted = await env.DB.prepare(`SELECT s.version,s.source_digest,o.normalized_name FROM identity_source_records s
      JOIN identity_observations o ON o.id=s.observation_id WHERE s.id=?1`).bind(raced.sourceRecordId)
      .first<{ version: number; source_digest: string; normalized_name: string }>();
    expect(persisted?.version).toBe(2);
    expect([[digest('c'), 'race left'], [digest('d'), 'race right']]).toContainEqual([persisted?.source_digest, persisted?.normalized_name]);
  });

  it('hashes arbitrary bounded caller source keys before either source or observation persistence', async () => {
    const rawKey = `Jane Doe +1 (415) 555-2671 amount=$125.00 ${next()}`;
    const input = sourceInput({ sourceRecordKey: rawKey });
    const record = await registerIdentitySource(env.DB, authEnv, input);
    expect(record.sourceRecordKey).toBe(rawKey);
    const persisted = await env.DB.prepare(`SELECT s.source_record_key,o.source_key FROM identity_source_records s
      JOIN identity_observations o ON o.id=s.observation_id WHERE s.id=?1`).bind(record.sourceRecordId)
      .first<{ source_record_key: string; source_key: string }>();
    expect(persisted?.source_record_key).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted?.source_key).toBe(persisted?.source_record_key);
    expect(JSON.stringify(persisted)).not.toContain('Jane Doe');
    expect(JSON.stringify(persisted)).not.toContain('415');
    expect(JSON.stringify(persisted)).not.toContain('125.00');
    expect(await registerIdentitySource(env.DB, authEnv, input)).toEqual(record);
    const otherSource = await registerIdentitySource(env.DB, authEnv, { ...input, source: 'registration' });
    const otherCampusId = next();
    await env.DB.prepare('INSERT INTO campuses(id,slug,name) VALUES(?1,?2,?3)')
      .bind(otherCampusId, `key-domain-${otherCampusId}`, 'Key Domain Campus').run();
    const otherCampus = await registerIdentitySource(env.DB, authEnv, { ...input, campusId: otherCampusId });
    const digests = await env.DB.prepare(`SELECT source_record_key FROM identity_source_records
      WHERE id IN (?1,?2,?3) ORDER BY id`).bind(record.sourceRecordId, otherSource.sourceRecordId, otherCampus.sourceRecordId)
      .all<{ source_record_key: string }>();
    expect(new Set(digests.results.map((row) => row.source_record_key))).toHaveLength(3);
    await expect(registerIdentitySource(env.DB, authEnv, sourceInput({ sourceRecordKey: `bad\nkey:${next()}` })))
      .rejects.toThrow('identity_source_invalid');
    await expect(registerIdentitySource(env.DB, authEnv, sourceInput({ sourceRecordKey: 'x'.repeat(513) })))
      .rejects.toThrow('identity_source_invalid');
  });

  it('uses a pinned source-key HMAC independent of verification-secret rotation and fails closed on key rotation', async () => {
    const rawKey = `low-entropy-${next()}`;
    const input = sourceInput({ sourceRecordKey: rawKey });
    const record = await registerIdentitySource(env.DB, authEnv, input);
    const stored = await env.DB.prepare('SELECT source_record_key FROM identity_source_records WHERE id=?1')
      .bind(record.sourceRecordId).first<string>('source_record_key');
    const material = new TextEncoder().encode(`identity-source-record-key:v2\0${input.campusId}\0${input.source}\0${rawKey}`);
    const plain = [...new Uint8Array(await crypto.subtle.digest('SHA-256', material))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(plain);
    const rotatedVerificationEnv = {
      ...authEnv, IDENTITY_VERIFICATION_SECRET: 'rotated-verification-secret-that-is-still-at-least-thirty-two-characters',
    };
    expect(await registerIdentitySource(env.DB, rotatedVerificationEnv, input)).toEqual(record);
    const pinned = await env.DB.prepare('SELECT key_id,verification_tag FROM identity_source_key_config WHERE singleton_id=1')
      .first<{ key_id: string; verification_tag: string }>();
    expect(pinned).toMatchObject({ key_id: 'v1' });
    expect(pinned?.verification_tag).toMatch(/^[0-9a-f]{64}$/);
    expect(await env.DB.prepare('SELECT source_key_id FROM identity_source_records WHERE id=?1')
      .bind(record.sourceRecordId).first<string>('source_key_id')).toBe('v1');
    await expect(env.DB.prepare("UPDATE identity_source_key_config SET key_id='v2' WHERE singleton_id=1").run())
      .rejects.toThrow(/identity_source_key_config_immutable/);
    await expect(env.DB.prepare('DELETE FROM identity_source_key_config WHERE singleton_id=1').run())
      .rejects.toThrow(/identity_source_key_config_immutable/);
    const sourceCount = await env.DB.prepare('SELECT count(*) n FROM identity_source_records').first<number>('n');
    await expect(registerIdentitySource(env.DB, {}, sourceInput())).rejects.toThrow('identity_source_key_secret_invalid');
    await expect(registerIdentitySource(env.DB, { ...authEnv, IDENTITY_SOURCE_KEY_SECRET: 'too-short' }, sourceInput()))
      .rejects.toThrow('identity_source_key_secret_invalid');
    await expect(registerIdentitySource(env.DB, { ...authEnv, IDENTITY_SOURCE_KEY_SECRET: `invalid ${'x'.repeat(32)}` }, sourceInput()))
      .rejects.toThrow('identity_source_key_secret_invalid');
    await expect(registerIdentitySource(env.DB, { ...authEnv, IDENTITY_SOURCE_KEY_SECRET:
      'rotated-stable-source-key-secret-that-is-at-least-thirty-two-characters' }, input))
      .rejects.toThrow('identity_source_key_configuration_mismatch');
    await expect(registerIdentitySource(env.DB, { ...authEnv, IDENTITY_SOURCE_KEY_ID: 'v2' }, input))
      .rejects.toThrow('identity_source_key_configuration_mismatch');
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_records').first<number>('n')).toBe(sourceCount);
  });

  it('adopts an exact pre-existing observation and removes any legacy raw-contact attachment into review', async () => {
    const owner = await person('Legacy Observation Owner'); const key = `legacy-observation:${next()}`;
    await env.DB.prepare(`INSERT INTO identity_observations(campus_id,source,source_key,normalized_email,normalized_name,status,linked_person_id)
      VALUES(1,'giving',?1,?2,'legacy member','linked',?3)`)
      .bind(key, `legacy-observation-${owner}@example.test`, owner).run();
    const adopted = await registerIdentitySource(env.DB, authEnv, sourceInput({
      sourceRecordKey: key, email: `legacy-observation-${owner}@example.test`, name: 'Legacy Member',
    }));
    expect(adopted).toMatchObject({ state: 'review', linkedPersonId: null });
    const observation = await env.DB.prepare('SELECT status,linked_person_id,source_key FROM identity_observations WHERE id=?1')
      .bind(adopted.observationId).first<{ status: string; linked_person_id: number | null; source_key: string }>();
    expect(observation).toMatchObject({ status: 'review', linked_person_id: null });
    expect(observation?.source_key).toMatch(/^[0-9a-f]{64}$/);
    expect(observation?.source_key).not.toBe(key);
  });

  it('never attaches an anonymous victim address before the exact source claim is consumed', async () => {
    const victim = await person('Victim');
    const email = `victim-${victim}@example.test`;
    await ownedContact(email, victim);
    const record = await registerIdentitySource(env.DB, authEnv, sourceInput({ email }));
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_source_records WHERE id=?1').bind(record.sourceRecordId).first<number>('linked_person_id')).toBeNull();
    const begun = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey,
      expectedVersion: 1, sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-01-01 00:00:00',
    });
    expect(begun.delivery.to).toBe(email);
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_source_records WHERE id=?1').bind(record.sourceRecordId).first<number>('linked_person_id')).toBeNull();
    const completed = await completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId,
      proof: { kind: 'otp', code: begun.delivery.kind === 'otp' ? begun.delivery.code : '' }, now: '2031-01-01 00:01:00',
    });
    expect(completed).toEqual({ status: 'attached', personId: victim });
    const replacement = await person('Claim Result Replacement');
    await expect(env.DB.prepare("UPDATE identity_claim_operations SET result_person_id=?1 WHERE operation_id=?2")
      .bind(replacement, begun.public.operationId).run()).rejects.toThrow(/identity_claim_operation_completed_immutable/);
    await expect(env.DB.prepare("UPDATE identity_claim_operations SET result_proof_kind='clean_signup' WHERE operation_id=?1")
      .bind(begun.public.operationId).run()).rejects.toThrow(/identity_claim_operation_completed_immutable/);
    await expect(env.DB.prepare("UPDATE identity_claim_operations SET state='review' WHERE operation_id=?1")
      .bind(begun.public.operationId).run()).rejects.toThrow(/identity_claim_operation_completed_immutable/);
    await expect(env.DB.prepare(`UPDATE identity_claim_operations SET source_record_id=source_record_id,
      challenge_id=challenge_id WHERE operation_id=?1`).bind(begun.public.operationId).run())
      .rejects.toThrow(/identity_claim_operation_(?:completed_)?immutable/);
  });

  it('attaches only the current canonical eligible signed-in campus member with exact CAS inputs', async () => {
    const member = await person('Signed Member');
    const record = await registerIdentitySource(env.DB, authEnv, sourceInput());
    const session = identityGatewaySessionContext({ personId: member, campusId: 1, sessionEpoch: 0 });
    await expect(attachIdentitySourceForSignedInSession(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey,
      expectedSourceRecordId: record.sourceRecordId + 1, expectedVersion: 1, sourceDigest: digest('a'), session,
    })).rejects.toThrow('identity_source_record_mismatch');
    expect(await attachIdentitySourceForSignedInSession(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey,
      expectedSourceRecordId: record.sourceRecordId, expectedVersion: 1, sourceDigest: digest('a'), session,
    })).toEqual({ status: 'attached', personId: member });
    expect(await env.DB.prepare('SELECT status,linked_person_id FROM identity_observations WHERE id=?1')
      .bind(record.observationId).first()).toMatchObject({ status: 'linked', linked_person_id: member });
    const blocked = await registerIdentitySource(env.DB, authEnv, sourceInput({ source: 'group', attachmentPolicy: 'observation_only' }));
    await expect(attachIdentitySourceForSignedInSession(env.DB, authEnv, {
      campusId: 1, source: 'group', sourceRecordKey: blocked.sourceRecordKey,
      expectedVersion: 1, sourceDigest: digest('a'), session,
    })).rejects.toThrow('identity_source_attachment_not_allowed');
    await expect(beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'group', sourceRecordKey: blocked.sourceRecordKey,
      expectedVersion: 1, sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(),
    })).rejects.toThrow('identity_source_claim_not_allowed');
  });

  it('fails closed when ownership changes after issuance and when a contact is shared', async () => {
    const first = await person('First Owner'); const second = await person('Second Owner');
    const email = `transfer-${first}@example.test`; const contact = await ownedContact(email, first);
    const record = await registerIdentitySource(env.DB, authEnv, sourceInput({ email }));
    const begun = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-02-01 00:00:00',
    });
    await ensureActivePersonContactLink(env.DB, { personId: second, contactPointId: contact.id, kind: 'email', source: 'test' });
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: contact.id, personId: second, transfer: true,
      proof: { kind: 'admin', actorPersonId: first, reasonCode: 'admin_review' } });
    expect(await completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId,
      proof: { kind: 'otp', code: begun.delivery.kind === 'otp' ? begun.delivery.code : '' }, now: '2031-02-01 00:01:00',
    })).toMatchObject({ status: 'review' });
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_source_records WHERE id=?1').bind(record.sourceRecordId).first<number>('linked_person_id')).toBeNull();

    const sharedEmail = `shared-${first}@example.test`; await ownedContact(sharedEmail, first, second);
    const shared = await registerIdentitySource(env.DB, authEnv, sourceInput({ email: sharedEmail }));
    const sharedClaim = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: shared.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-02-01 00:02:00',
    });
    expect(await completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: sharedClaim.public.operationId, publicId: sharedClaim.delivery.publicId,
      proof: { kind: 'otp', code: sharedClaim.delivery.kind === 'otp' ? sharedClaim.delivery.code : '' }, now: '2031-02-01 00:03:00',
    })).toMatchObject({ status: 'review' });
  });

  it('serializes person and household contact sharing mutations against a consumed pending source claim', async () => {
    const owner = await person('Serialized Owner'); const other = await person('Serialized Other');
    const email = `serialized-${owner}@example.test`; const contact = await ownedContact(email, owner);
    const record = await registerIdentitySource(env.DB, authEnv, sourceInput({ email }));
    const begun = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-02-03 00:00:00',
    });
    expect(await consumeEmailOtpChallenge(env.DB, authEnv, {
      campusId: 1, publicId: begun.delivery.publicId, purpose: 'claim',
      code: begun.delivery.kind === 'otp' ? begun.delivery.code : '', now: '2031-02-03 00:01:00',
    })).toMatchObject({ ok: true });
    await expect(env.DB.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source)
      VALUES(?1,?2,'email','test')`).bind(other, contact.id).run())
      .rejects.toThrow(/identity_claim_contact_mutation_conflict/);
    const endedPersonLink = next();
    await env.DB.prepare(`INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source,ended_at)
      VALUES(?1,?2,?3,'email','test',datetime('now'))`).bind(endedPersonLink, other, contact.id).run();
    await expect(env.DB.prepare('UPDATE person_contact_links SET ended_at=NULL WHERE id=?1').bind(endedPersonLink).run())
      .rejects.toThrow(/identity_claim_contact_mutation_conflict/);
    const householdId = next(); const endedHouseholdLink = next();
    await env.DB.prepare('INSERT INTO households(id,name) VALUES(?1,?2)').bind(householdId, 'Serialized Household').run();
    await expect(env.DB.prepare(`INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source)
      VALUES(1,?1,?2,'test')`).bind(householdId, contact.id).run())
      .rejects.toThrow(/identity_claim_contact_mutation_conflict/);
    await env.DB.prepare(`INSERT INTO household_contact_links(id,campus_id,household_id,contact_point_id,source,ended_at)
      VALUES(?1,1,?2,?3,'test',datetime('now'))`).bind(endedHouseholdLink, householdId, contact.id).run();
    await expect(env.DB.prepare('UPDATE household_contact_links SET ended_at=NULL WHERE id=?1').bind(endedHouseholdLink).run())
      .rejects.toThrow(/identity_claim_contact_mutation_conflict/);
  });

  it('does not treat a global contact owner without membership in the source campus as the claimant', async () => {
    const otherCampus = next();
    await env.DB.prepare('INSERT INTO campuses(id,slug,name) VALUES(?1,?2,?3)')
      .bind(otherCampus, `source-campus-${otherCampus}`, 'Other Source Campus').run();
    const owner = await person('Other Campus Owner', otherCampus);
    const email = `other-campus-${owner}@example.test`; await ownedContact(email, owner);
    const record = await registerIdentitySource(env.DB, authEnv, sourceInput({ email }));
    const begun = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-02-02 00:00:00',
    });
    expect(await completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId,
      proof: { kind: 'otp', code: begun.delivery.kind === 'otp' ? begun.delivery.code : '' }, now: '2031-02-02 00:01:00',
    })).toMatchObject({ status: 'review' });
  });

  it('binds a claim to the exact source version/digest and writes one receipt under concurrency', async () => {
    const owner = await person('Concurrent Owner'); const email = `concurrent-${owner}@example.test`; await ownedContact(email, owner);
    const input = sourceInput({ email }); const record = await registerIdentitySource(env.DB, authEnv, input);
    const begun = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-03-01 00:00:00',
    });
    const complete = () => completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId,
      proof: { kind: 'otp' as const, code: begun.delivery.kind === 'otp' ? begun.delivery.code : '' }, now: '2031-03-01 00:01:00',
    });
    const results = await Promise.all([complete(), complete(), complete()]);
    expect(results.every((result) => result.status === 'attached' && result.personId === owner)).toBe(true);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_attachment_receipts WHERE source_record_id=?1')
      .bind(record.sourceRecordId).first<number>('n')).toBe(1);

    const staleInput = sourceInput({ email: `stale-${owner}@example.test` }); const stale = await registerIdentitySource(env.DB, authEnv, staleInput);
    const staleClaim = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: stale.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-03-01 00:02:00',
    });
    await registerIdentitySource(env.DB, authEnv, { ...staleInput, sourceDigest: digest('b'), replaceVersion: { expectedVersion: 1 } });
    expect(await completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: staleClaim.public.operationId, publicId: staleClaim.delivery.publicId,
      proof: { kind: 'otp', code: staleClaim.delivery.kind === 'otp' ? staleClaim.delivery.code : '' }, now: '2031-03-01 00:03:00',
    })).toEqual({ status: 'stale' });
  });

  it('supports a target-safe one-time email link as an alternative to the OTP', async () => {
    const owner = await person('Link Owner'); const email = `link-owner-${owner}@example.test`; await ownedContact(email, owner);
    const record = await registerIdentitySource(env.DB, authEnv, sourceInput({ email }));
    const begun = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: record.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'link', requestContext: requestContext(), now: '2031-03-02 00:00:00',
    });
    expect(begun.delivery.kind).toBe('link');
    expect(await completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId,
      proof: { kind: 'link', token: begun.delivery.kind === 'link' ? begun.delivery.token : '' }, now: '2031-03-02 00:01:00',
    })).toEqual({ status: 'attached', personId: owner });
  });

  it('can attach a separately verified clean signup account only after it becomes the bound owner', async () => {
    const email = `clean-signup-${next()}@example.test`;
    const signup = await beginSignup(env.DB, authEnv, { campusId: 1, email, displayName: 'Clean Signup',
      requestContext: requestContext(), now: '2031-04-01 00:00:00' });
    const account = await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: signup.public.operationId,
      publicId: signup.delivery.publicId, code: signup.delivery.code, now: '2031-04-01 00:01:00' });
    expect(account.status).toBe('authenticated');
    const source = await registerIdentitySource(env.DB, authEnv, sourceInput({ email }));
    const claim = await beginSourceClaim(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey, expectedVersion: 1,
      sourceDigest: digest('a'), mode: 'otp', requestContext: requestContext(), now: '2031-04-01 00:02:00',
    });
    const completed = await completeSourceClaim(env.DB, authEnv, {
      campusId: 1, operationId: claim.public.operationId, publicId: claim.delivery.publicId,
      proof: { kind: 'otp', code: claim.delivery.kind === 'otp' ? claim.delivery.code : '' },
      now: '2031-04-01 00:03:00',
    });
    expect(completed).toMatchObject({ status: 'attached' });
  });

  it('creates one inactive auth-disabled provisional notification profile under concurrency and never an orphan loser', async () => {
    const displayName = `Concurrent Provisional ${next()}`;
    const input = sourceInput({ source: 'newcomer', attachmentPolicy: 'observation_only', phone: '+1 415 555 2671', name: displayName });
    const record = await registerIdentitySource(env.DB, authEnv, input);
    const create = () => createProvisionalPersonForObservation(env.DB, authEnv, {
      campusId: 1, source: 'newcomer', sourceRecordKey: record.sourceRecordKey, expectedVersion: 1, sourceDigest: digest('a'),
    });
    const attempts = await Promise.all([create(), create(), create()]);
    expect(new Set(attempts.map((attempt) => attempt.personId))).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    const created = attempts[0];
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_provisional_operations WHERE source_record_id=?1')
      .bind(record.sourceRecordId).first<number>('n')).toBe(1);
    await expect(env.DB.prepare('DELETE FROM identity_source_provisional_operations WHERE source_record_id=?1')
      .bind(record.sourceRecordId).run()).rejects.toThrow(/identity_source_provisional_operations_append_only/);
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE display_name=?1 AND identity_state=\'provisional\'')
      .bind(displayName.toLocaleLowerCase('en-US')).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT active,identity_state,auth_disabled_at,email FROM people WHERE id=?1').bind(created.personId).first())
      .toMatchObject({ active: 0, identity_state: 'provisional' });
    expect(await env.DB.prepare(`SELECT count(*) n FROM verified_contact_owners o
      JOIN person_contact_links l ON l.contact_point_id=o.contact_point_id WHERE l.person_id=?1`).bind(created.personId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM person_contact_links WHERE person_id=?1 AND notification_enabled=1')
      .bind(created.personId).first<number>('n')).toBe(2);
    await expect(registerIdentitySource(env.DB, authEnv, {
      ...input, sourceDigest: digest('b'), replaceVersion: { expectedVersion: 1 },
    })).rejects.toThrow('identity_source_version_conflict');

    const raceName = `Provisional Replace Race ${next()}`;
    const raceInput = sourceInput({ source: 'newcomer', attachmentPolicy: 'observation_only', name: raceName });
    const raceSource = await registerIdentitySource(env.DB, authEnv, raceInput);
    const [createRace, replaceRace] = await Promise.allSettled([
      createProvisionalPersonForObservation(env.DB, authEnv, { campusId: 1, source: 'newcomer',
        sourceRecordKey: raceSource.sourceRecordKey, expectedVersion: 1, sourceDigest: digest('a') }),
      registerIdentitySource(env.DB, authEnv, { ...raceInput, name: `${raceName} replacement`, sourceDigest: digest('b'),
        replaceVersion: { expectedVersion: 1 } }),
    ]);
    expect([createRace.status, replaceRace.status].sort()).toEqual(['fulfilled', 'rejected']);
    const durableRace = await env.DB.prepare(`SELECT s.version,s.source_digest,s.provisional_person_id,
      (SELECT count(*) FROM identity_source_provisional_operations op WHERE op.source_record_id=s.id) operation_count,
      (SELECT count(*) FROM identity_source_provisional_receipts r WHERE r.source_record_id=s.id) receipt_count
      FROM identity_source_records s WHERE s.id=?1`).bind(raceSource.sourceRecordId)
      .first<{ version: number; source_digest: string; provisional_person_id: number | null; operation_count: number; receipt_count: number }>();
    if (createRace.status === 'fulfilled') {
      expect(durableRace).toMatchObject({ version: 1, source_digest: digest('a'),
        provisional_person_id: createRace.value.personId, operation_count: 1, receipt_count: 1 });
    } else {
      expect(durableRace).toMatchObject({ version: 2, source_digest: digest('b'),
        provisional_person_id: null, operation_count: 0, receipt_count: 0 });
      expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE display_name=?1')
        .bind(raceName.toLocaleLowerCase('en-US')).first<number>('n')).toBe(0);
    }
  });

  it('allows provisional people only for unlinked group, newcomer, and import observations', async () => {
    for (const source of ['group', 'newcomer', 'import'] as const) {
      const record = await registerIdentitySource(env.DB, authEnv, sourceInput({ source, attachmentPolicy: 'observation_only' }));
      await expect(createProvisionalPersonForObservation(env.DB, authEnv, {
        campusId: 1, source, sourceRecordKey: record.sourceRecordKey, expectedVersion: 1, sourceDigest: digest('a'),
      })).resolves.toMatchObject({ created: true });
    }
    for (const [source, attachmentPolicy] of [
      ['giving', 'signed_in_or_claim'], ['registration', 'signed_in_or_claim'],
      ['team', 'signed_in_or_claim'], ['planning_center', 'external_review'],
    ] as const) {
      const record = await registerIdentitySource(env.DB, authEnv, sourceInput({ source, attachmentPolicy }));
      await expect(createProvisionalPersonForObservation(env.DB, authEnv, {
        campusId: 1, source, sourceRecordKey: record.sourceRecordKey, expectedVersion: 1, sourceDigest: digest('a'),
      })).rejects.toThrow('identity_source_provisional_not_allowed');
    }
    const review = await registerIdentitySource(env.DB, authEnv, sourceInput({ source: 'newcomer', attachmentPolicy: 'observation_only' }));
    await env.DB.prepare("UPDATE identity_source_records SET state='review' WHERE id=?1").bind(review.sourceRecordId).run();
    await expect(createProvisionalPersonForObservation(env.DB, authEnv, {
      campusId: 1, source: 'newcomer', sourceRecordKey: review.sourceRecordKey, expectedVersion: 1, sourceDigest: digest('a'),
    })).rejects.toThrow('identity_source_provisional_not_allowed');
  });

  it('requires explicit reconciliation before a source with a provisional profile can attach a canonical person', async () => {
    const canonical = await person('Canonical After Provisional');
    const source = await registerIdentitySource(env.DB, authEnv, sourceInput({ source: 'newcomer', attachmentPolicy: 'observation_only' }));
    const provisional = await createProvisionalPersonForObservation(env.DB, authEnv, {
      campusId: 1, source: 'newcomer', sourceRecordKey: source.sourceRecordKey, expectedVersion: 1, sourceDigest: digest('a'),
    });
    await expect(attachIdentitySourceForSignedInSession(env.DB, authEnv, {
      campusId: 1, source: 'newcomer', sourceRecordKey: source.sourceRecordKey,
      expectedVersion: 1, sourceDigest: digest('a'),
      session: identityGatewaySessionContext({ personId: canonical, campusId: 1, sessionEpoch: 0 }),
    })).rejects.toThrow('identity_source_reconciliation_required');
    await expect(env.DB.prepare(`INSERT INTO identity_source_attachment_receipts(receipt_id,campus_id,source_record_id,
      source_version,source_digest,person_id,proof_kind,session_epoch) VALUES(?1,1,?2,1,?3,?4,'signed_session',0)`)
      .bind(crypto.randomUUID(), source.sourceRecordId, digest('a'), canonical).run())
      .rejects.toThrow(/identity_source_attachment_proof_invalid/);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_attachment_receipts WHERE source_record_id=?1')
      .bind(source.sourceRecordId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT linked_person_id,provisional_person_id FROM identity_source_records WHERE id=?1')
      .bind(source.sourceRecordId).first()).toEqual({ linked_person_id: null, provisional_person_id: provisional.personId });
  });
});
