import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  assignVerifiedContactOwner,
  ensureActivePersonContactLink,
  findVerifiedContactOwner,
  revokeVerifiedContactOwner,
  upsertContactPoint,
  validateIdentityAuditMetadata,
  upsertIdentityObservation,
} from '../src/lib/identityDb';
import { consumeEmailOtpChallenge, identityTrustedRequestContext, issueEmailOtpChallenge } from '../src/lib/identityAuth';
import type { AppDb } from '../src/lib/appDb';

const authEnv = { IDENTITY_VERIFICATION_SECRET: 'identity-test-secret-that-is-at-least-thirty-two-characters' };
const requestContext = () => identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.77' }), `identity-db-${++nextId}`);

let nextId = 97000;
async function person(name: string, state = 'active') {
  const id = ++nextId;
  await env.DB.prepare(`INSERT INTO people (id, display_name, email, identity_state, role, super_admin)
    VALUES (?1, ?2, ?3, ?4, 'admin', 1)`).bind(id, name, `identity-${id}@example.test`, state).run();
  return id;
}

describe('identity repository', () => {
  it('canonicalizes a contact once without replacing its normalized identity', async () => {
    const first = await upsertContactPoint(env.DB, { kind: 'email', value: '  Member@Example.TEST ' });
    const second = await upsertContactPoint(env.DB, { kind: 'email', value: 'member@example.test', displayValue: 'A different display' });
    expect(second).toMatchObject({ id: first.id, normalizedValue: 'member@example.test', displayValue: first.displayValue });
  });

  it('rejects control characters in contact display and observation text inputs', async () => {
    await expect(upsertContactPoint(env.DB, { kind: 'email', value: `control-${++nextId}@example.test`, displayValue: 'Member\nInjected' }))
      .rejects.toThrow('identity_contact_invalid');
    await expect(upsertIdentityObservation(env.DB, { campusId: 1, source: 'signup', sourceKey: 'bad\u007fkey', candidates: [] }))
      .rejects.toThrow('identity_observation_invalid');
    await expect(upsertIdentityObservation(env.DB, { campusId: 1, source: 'signup', sourceKey: `control-${++nextId}`, name: 'Member\0Injected', candidates: [] }))
      .rejects.toThrow('identity_observation_invalid');
    await expect(upsertIdentityObservation(env.DB, { campusId: 1, source: 'planning_center', sourceKey: `external-control-${++nextId}`, candidates: [],
      externalIdentity: { provider: 'planning\ncenter', organizationId: 'org', externalPersonId: 'person' } }))
      .rejects.toThrow('identity_observation_invalid');
  });

  it('creates one active person-contact link under concurrency', async () => {
    const owner = await person('Concurrent Link Owner');
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: `link-race-${owner}@example.test` });
    await Promise.all(Array.from({ length: 8 }, () => ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' })));
    expect(await env.DB.prepare('SELECT count(*) n FROM person_contact_links WHERE person_id=?1 AND contact_point_id=?2 AND ended_at IS NULL').bind(owner, point.id).first<number>('n')).toBe(1);
  });

  it('supports shared links but requires an explicit ownership transfer', async () => {
    const one = await person('Owner One');
    const two = await person('Owner Two');
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: `shared-${one}@example.test` });
    await ensureActivePersonContactLink(env.DB, { personId: one, contactPointId: point.id, kind: 'email', source: 'test' });
    await ensureActivePersonContactLink(env.DB, { personId: two, contactPointId: point.id, kind: 'email', source: 'test' });
    const proof = { kind: 'admin', actorPersonId: one, reasonCode: 'admin_review' } as const;
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: one, proof });
    await expect(assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: two, proof }))
      .rejects.toThrow('identity_owner_transfer_required');
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: two, proof, transfer: true });
    expect((await findVerifiedContactOwner(env.DB, { kind: 'email', value: `shared-${one}@example.test` }))?.personId).toBe(two);
    const events = await env.DB.prepare('SELECT event_type FROM contact_ownership_events WHERE contact_point_id=?1 ORDER BY id').bind(point.id).all<{ event_type: string }>();
    expect(events.results.map((row) => row.event_type)).toEqual(['verified', 'revoked', 'transferred']);
  });

  it('rejects disabled, deleted, and merge-redirected owners', async () => {
    const owner = await person('Blocked Owner');
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: `blocked-${owner}@example.test` });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof: { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } });
    await env.DB.prepare('UPDATE people SET auth_disabled_at=datetime(\'now\') WHERE id=?1').bind(owner).run();
    expect(await findVerifiedContactOwner(env.DB, { kind: 'email', value: `blocked-${owner}@example.test` })).toBeNull();
  });

  it('requires a segregated ownership proof instead of a caller-selected method', async () => {
    const owner = await person('Unproven Owner');
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: `unproven-${owner}@example.test` });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    await expect(assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner } as never)).rejects.toThrow('identity_owner_proof_required');
  });

  it('accepts bounded structural audit metadata and rejects PII-shaped data', () => {
    expect(validateIdentityAuditMetadata({ challengeId: 7, signalCount: 2, signals: ['verified_owner'] })).toEqual({ challengeId: 7, signalCount: 2, signals: ['verified_owner'] });
    for (const invalid of [
      { email: 'member@example.test' }, { sourceIp: '127.0.0.1' }, { code: '123456' },
      { providerPayload: { arbitrary: 'value' } }, { notes: 'hello' }, { amount: 50 },
      { arbitrary: 'verified_owner' }, { reasonCategory: 'member@example.test' },
      { reasonCategory: '+14155552671' }, { signals: ['127.0.0.1'] },
      { previousOwnerId: '4155552671' }, { reasonCategory: '123456' },
    ]) expect(validateIdentityAuditMetadata(invalid)).toBeNull();
  });

  it('uses a consumed claim proof only for its unique safe linked person', async () => {
    const owner = await person('Claim Owner');
    const email = `claim-${owner}@example.test`;
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'claim', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'claim', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof: { kind: 'challenge', publicId: issued.publicId, purpose: 'claim', reasonCode: 'verified_email' } });
    expect((await findVerifiedContactOwner(env.DB, { kind: 'email', value: email }))?.personId).toBe(owner);
    expect(await env.DB.prepare('SELECT person_id FROM identity_challenge_proof_uses WHERE challenge_id=(SELECT id FROM identity_challenges WHERE public_id=?1)').bind(issued.publicId).first<number>('person_id')).toBe(owner);
  });

  it('never lets a shared claim contact select one of several linked people', async () => {
    const one = await person('Shared Claim One');
    const two = await person('Shared Claim Two');
    const email = `shared-claim-${one}@example.test`;
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: one, contactPointId: point.id, kind: 'email', source: 'test' });
    await ensureActivePersonContactLink(env.DB, { personId: two, contactPointId: point.id, kind: 'email', source: 'test' });
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'claim', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'claim', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    await expect(assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: one, proof: { kind: 'challenge', publicId: issued.publicId, purpose: 'claim', reasonCode: 'verified_email' } }))
      .rejects.toThrow('identity_owner_review_required');
    expect(await findVerifiedContactOwner(env.DB, { kind: 'email', value: email })).toBeNull();
  });

  it('treats a household-linked address as shared even with one person link', async () => {
    const owner = await person('Household Claim Owner'); const householdId = ++nextId;
    const email = `household-claim-${owner}@example.test`;
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households(id,name) VALUES(?1,'Shared Household')").bind(householdId),
      env.DB.prepare("INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source) VALUES(1,?1,?2,'test')").bind(householdId, point.id),
    ]);
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'claim', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'claim', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    await expect(assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof: { kind: 'challenge', publicId: issued.publicId, purpose: 'claim', reasonCode: 'verified_email' } }))
      .rejects.toThrow('identity_owner_review_required');
  });

  it.each(['person', 'household'] as const)('revalidates claim sharing at proof-use time after a late %s link', async (lateLink) => {
    const owner = await person(`Late ${lateLink} Owner`); const email = `late-${lateLink}-${owner}@example.test`;
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    const issued = await issueEmailOtpChallenge(env.DB, authEnv, { campusId: 1, email, purpose: 'claim', requestContext: requestContext(), now: '2030-01-01 00:00:00' });
    expect((await consumeEmailOtpChallenge(env.DB, authEnv, { campusId: 1, publicId: issued.publicId, purpose: 'claim', code: issued.code, now: '2030-01-01 00:01:00' })).ok).toBe(true);
    if (lateLink === 'person') {
      const second = await person('Late Shared Person');
      await ensureActivePersonContactLink(env.DB, { personId: second, contactPointId: point.id, kind: 'email', source: 'test' });
    } else {
      const householdId = ++nextId;
      await env.DB.batch([
        env.DB.prepare("INSERT INTO households(id,name) VALUES(?1,'Late Shared Household')").bind(householdId),
        env.DB.prepare("INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source) VALUES(1,?1,?2,'test')").bind(householdId, point.id),
      ]);
    }
    await expect(assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof: { kind: 'challenge', publicId: issued.publicId, purpose: 'claim', reasonCode: 'verified_email' } }))
      .rejects.toThrow('identity_owner_review_required');
    expect(await env.DB.prepare('SELECT count(*) n FROM verified_contact_owners WHERE contact_point_id=?1').bind(point.id).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM contact_ownership_events WHERE contact_point_id=?1').bind(point.id).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_audit_events WHERE contact_point_id=?1').bind(point.id).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_challenge_proof_uses WHERE contact_point_id=?1').bind(point.id).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM contact_owner_mutation_claims WHERE contact_point_id=?1').bind(point.id).first<number>('n')).toBe(0);
  });

  it('keeps an observation idempotent, returns stable case ids, and rejects payload drift', async () => {
    const candidate = await person('Observation Candidate');
    const input = { campusId: 1, source: 'signup' as const, sourceKey: `retry-${++nextId}`, email: `observe-${nextId}@example.test`, candidates: [{ personId: candidate, nameSimilarity: true }] };
    const first = await upsertIdentityObservation(env.DB, input);
    const second = await upsertIdentityObservation(env.DB, input);
    expect(second).toEqual(first);
    await expect(upsertIdentityObservation(env.DB, { ...input, email: `changed-${nextId}@example.test` })).rejects.toThrow('identity_observation_payload_drift');
  });

  it('acquires one observation under same-key concurrency and completes partial retries', async () => {
    const candidate = await person('Concurrent Observation Candidate');
    const input = { campusId: 1, source: 'signup' as const, sourceKey: `parallel-${++nextId}`, email: `parallel-${nextId}@example.test`, candidates: [{ personId: candidate, nameSimilarity: true }] };
    const results = await Promise.all(Array.from({ length: 6 }, () => upsertIdentityObservation(env.DB, input)));
    expect(new Set(results.map((result) => result.observationId))).toHaveLength(1);
    expect(new Set(results.flatMap((result) => result.caseIds))).toHaveLength(1);
    const partialKey = `partial-${++nextId}`;
    await env.DB.prepare("INSERT INTO identity_observations(campus_id,source,source_key,normalized_email,status) VALUES(1,'signup',?1,?2,'provisional')")
      .bind(partialKey, `partial-${nextId}@example.test`).run();
    const resumed = await upsertIdentityObservation(env.DB, { ...input, sourceKey: partialKey, email: `partial-${nextId}@example.test` });
    expect(resumed.outcome).toBe('review');
    expect(resumed.caseIds).toHaveLength(1);
  });

  it('never trusts forged strong contact or external evidence from a caller', async () => {
    const candidate = await person('Forged Evidence Target');
    const forged = await upsertIdentityObservation(env.DB, {
      campusId: 1, source: 'signup', sourceKey: `forged-contact-${++nextId}`, email: `unowned-${nextId}@example.test`,
      candidates: [{ personId: candidate, exactContact: 'verified_owner' }],
    } as never);
    expect(forged.outcome).not.toBe('matched');
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_observations WHERE id=?1').bind(forged.observationId).first<number>('linked_person_id')).toBeNull();
    await expect(upsertIdentityObservation(env.DB, {
      campusId: 1, source: 'signup', sourceKey: `forged-external-${++nextId}`, candidates: [{ personId: candidate }],
      externalIdentity: { personId: candidate, trusted: true, exact: true },
    } as never)).rejects.toThrow('identity_observation_invalid');
  });

  it('derives exact external identity evidence only from a current verified DB mapping', async () => {
    const owner = await person('External Mapping Owner');
    const provider = `provider-${++nextId}`; const organizationId = `org-${nextId}`; const externalPersonId = `person-${owner}`;
    await env.DB.prepare(`INSERT INTO person_external_identities(person_id,provider,organization_id,external_person_id,verified_at)
      VALUES(?1,?2,?3,?4,datetime('now'))`).bind(owner, provider, organizationId, externalPersonId).run();
    const matched = await upsertIdentityObservation(env.DB, {
      campusId: 1, source: 'planning_center', sourceKey: `external-match-${++nextId}`, candidates: [],
      externalIdentity: { provider, organizationId, externalPersonId },
    });
    expect(matched.outcome).toBe('matched');
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_observations WHERE id=?1').bind(matched.observationId).first<number>('linked_person_id')).toBe(owner);

    await env.DB.prepare('UPDATE person_external_identities SET verified_at=NULL WHERE provider=?1 AND organization_id=?2 AND external_person_id=?3')
      .bind(provider, organizationId, externalPersonId).run();
    const unverified = await upsertIdentityObservation(env.DB, {
      campusId: 1, source: 'planning_center', sourceKey: `external-unverified-${++nextId}`, candidates: [],
      externalIdentity: { provider, organizationId, externalPersonId },
    });
    expect(unverified.outcome).toBe('provisional');
  });

  it('blocks conflicting DB-verified external and contact owners', async () => {
    const externalOwner = await person('External Conflict Owner'); const contactOwner = await person('Contact Conflict Owner');
    const provider = `conflict-provider-${++nextId}`; const organizationId = `org-${nextId}`; const externalPersonId = `person-${externalOwner}`;
    await env.DB.prepare(`INSERT INTO person_external_identities(person_id,provider,organization_id,external_person_id,verified_at)
      VALUES(?1,?2,?3,?4,datetime('now'))`).bind(externalOwner, provider, organizationId, externalPersonId).run();
    const email = `external-conflict-${contactOwner}@example.test`; const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: contactOwner, contactPointId: point.id, kind: 'email', source: 'test' });
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: contactOwner,
      proof: { kind: 'admin', actorPersonId: contactOwner, reasonCode: 'admin_review' } });
    const blocked = await upsertIdentityObservation(env.DB, { campusId: 1, source: 'planning_center', sourceKey: `external-conflict-${++nextId}`,
      email, candidates: [], externalIdentity: { provider, organizationId, externalPersonId } });
    expect(blocked.outcome).toBe('blocked');
    expect(await env.DB.prepare('SELECT status FROM identity_observations WHERE id=?1').bind(blocked.observationId).first<string>('status')).toBe('dismissed');
  });

  it.each(['inactive', 'merged'] as const)('does not auto-link a DB-verified contact to an %s target', async (state) => {
    const owner = await person(`Unsafe ${state} Target`); const email = `unsafe-${state}-${owner}@example.test`;
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof: { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } });
    if (state === 'inactive') await env.DB.prepare('UPDATE people SET active=0 WHERE id=?1').bind(owner).run();
    else await env.DB.prepare("UPDATE people SET identity_state='merged',auth_disabled_at=datetime('now') WHERE id=?1").bind(owner).run();
    const result = await upsertIdentityObservation(env.DB, { campusId: 1, source: 'signup', sourceKey: `unsafe-${state}-${++nextId}`, email, candidates: [{ personId: owner }] });
    expect(result.outcome).not.toBe('matched');
  });

  it('treats every active contact link as sharing evidence even when another linked profile is inactive', async () => {
    const owner = await person('Eligible Contact Owner'); const stale = await person('Inactive Shared Link');
    const email = `inactive-shared-${owner}@example.test`; const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    await ensureActivePersonContactLink(env.DB, { personId: stale, contactPointId: point.id, kind: 'email', source: 'test' });
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner,
      proof: { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } });
    await env.DB.prepare('UPDATE people SET active=0 WHERE id=?1').bind(stale).run();
    const result = await upsertIdentityObservation(env.DB, { campusId: 1, source: 'signup', sourceKey: `inactive-shared-${++nextId}`, email, candidates: [] });
    expect(result.outcome).toBe('review');
  });

  it('derives verified ownership from DB and closes stale review cases when retry becomes matched', async () => {
    const owner = await person('Derived Match Owner'); const email = `derived-match-${owner}@example.test`;
    const input = { campusId: 1, source: 'signup' as const, sourceKey: `derived-${++nextId}`, email, candidates: [{ personId: owner, nameSimilarity: true }] };
    const review = await upsertIdentityObservation(env.DB, input);
    expect(review.outcome).toBe('review'); expect(review.caseIds).toHaveLength(1);
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof: { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } });
    const matched = await upsertIdentityObservation(env.DB, input);
    expect(matched).toMatchObject({ observationId: review.observationId, outcome: 'matched', caseIds: [] });
    expect(await env.DB.prepare('SELECT state FROM identity_resolution_cases WHERE id=?1').bind(review.caseIds[0]).first<string>('state')).toBe('dismissed');
    expect(await env.DB.prepare('SELECT resolved_at IS NOT NULL closed FROM identity_resolution_cases WHERE id=?1').bind(review.caseIds[0]).first<number>('closed')).toBe(1);
  });

  it.each(['revoke', 'transfer', 'inactive', 'merged'] as const)('fails closed when %s invalidates match evidence immediately before the final write', async (mutation) => {
    const owner = await person(`Interleaved ${mutation} Owner`); const email = `interleaved-${mutation}-${owner}@example.test`;
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    const proof = { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } as const;
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof });
    let fired = false;
    const hookedDb: AppDb = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          if (mutation === 'revoke') await revokeVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, proof });
          else if (mutation === 'transfer') {
            const replacement = await person('Interleaved Transfer Target');
            await ensureActivePersonContactLink(env.DB, { personId: replacement, contactPointId: point.id, kind: 'email', source: 'test' });
            await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: replacement, proof, transfer: true });
          } else if (mutation === 'inactive') await env.DB.prepare('UPDATE people SET active=0 WHERE id=?1').bind(owner).run();
          else await env.DB.prepare("UPDATE people SET identity_state='merged',auth_disabled_at=datetime('now') WHERE id=?1").bind(owner).run();
        }
        return env.DB.batch(statements);
      },
    };
    const result = await upsertIdentityObservation(hookedDb, { campusId: 1, source: 'signup', sourceKey: `interleaved-${mutation}-${++nextId}`, email, candidates: [] });
    expect(fired).toBe(true);
    expect(result.outcome).toBe('provisional');
    expect(await env.DB.prepare('SELECT status FROM identity_observations WHERE id=?1').bind(result.observationId).first<string>('status')).toBe('provisional');
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_observations WHERE id=?1').bind(result.observationId).first<number>('linked_person_id')).toBeNull();
  });

  it.each(['unverified', 'inactive'] as const)('revalidates external identity mapping when it becomes %s before the final write', async (mutation) => {
    const owner = await person(`Interleaved External ${mutation}`); const provider = `interleaved-provider-${++nextId}`;
    const organizationId = `org-${nextId}`; const externalPersonId = `external-${owner}`;
    await env.DB.prepare(`INSERT INTO person_external_identities(person_id,provider,organization_id,external_person_id,verified_at)
      VALUES(?1,?2,?3,?4,datetime('now'))`).bind(owner, provider, organizationId, externalPersonId).run();
    let fired = false;
    const hookedDb: AppDb = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          if (mutation === 'unverified') await env.DB.prepare('UPDATE person_external_identities SET verified_at=NULL WHERE person_id=?1 AND provider=?2')
            .bind(owner, provider).run();
          else await env.DB.prepare('UPDATE people SET active=0 WHERE id=?1').bind(owner).run();
        }
        return env.DB.batch(statements);
      },
    };
    const result = await upsertIdentityObservation(hookedDb, { campusId: 1, source: 'planning_center', sourceKey: `interleaved-external-${mutation}-${++nextId}`,
      candidates: [], externalIdentity: { provider, organizationId, externalPersonId } });
    expect(result.outcome).toBe('provisional');
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_observations WHERE id=?1').bind(result.observationId).first<number>('linked_person_id')).toBeNull();
  });

  it('atomically dismisses removed review candidates while preserving and upserting current cases', async () => {
    const removed = await person('Removed Review Candidate'); const retained = await person('Retained Review Candidate');
    const added = await person('Added Review Candidate');
    const input = { campusId: 1, source: 'signup' as const, sourceKey: `review-candidates-${++nextId}`,
      candidates: [{ personId: removed, nameSimilarity: true }, { personId: retained, nameSimilarity: true }] };
    const first = await upsertIdentityObservation(env.DB, input);
    expect(first.outcome).toBe('review'); expect(first.caseIds).toHaveLength(2);
    const retainedCaseId = await env.DB.prepare('SELECT id FROM identity_resolution_cases WHERE observation_id=?1 AND candidate_person_id=?2 AND state=\'open\'')
      .bind(first.observationId, retained).first<number>('id');
    const retried = await upsertIdentityObservation(env.DB, { ...input,
      candidates: [{ personId: retained, nameSimilarity: true, dateOfBirthMatch: true }, { personId: added, nameSimilarity: true }] });
    expect(retried.outcome).toBe('review'); expect(retried.caseIds).toHaveLength(2);
    expect(await env.DB.prepare('SELECT state FROM identity_resolution_cases WHERE observation_id=?1 AND candidate_person_id=?2 ORDER BY id DESC')
      .bind(first.observationId, removed).first<string>('state')).toBe('dismissed');
    expect(await env.DB.prepare('SELECT id FROM identity_resolution_cases WHERE observation_id=?1 AND candidate_person_id=?2 AND state=\'open\'')
      .bind(first.observationId, retained).first<number>('id')).toBe(retainedCaseId);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_resolution_cases WHERE observation_id=?1 AND state=\'open\' AND candidate_person_id IN (?2,?3)')
      .bind(first.observationId, retained, added).first<number>('n')).toBe(2);
  });

  it.each([
    ['provisional', async (candidate: number) => env.DB.prepare('UPDATE people SET active=0 WHERE id=?1').bind(candidate).run(), {}],
    ['dismissed', async () => undefined, { conflictingDob: true }],
  ] as const)('closes stale review cases when retry becomes %s', async (expectedStatus, mutate, changedEvidence) => {
    const candidate = await person(`Changing Evidence ${expectedStatus}`);
    const input = { campusId: 1, source: 'signup' as const, sourceKey: `changing-${expectedStatus}-${++nextId}`,
      candidates: [{ personId: candidate, nameSimilarity: true }] };
    const review = await upsertIdentityObservation(env.DB, input);
    expect(review.outcome).toBe('review');
    await mutate(candidate);
    const retried = await upsertIdentityObservation(env.DB, { ...input, candidates: [{ ...input.candidates[0], ...changedEvidence }] });
    expect(retried.caseIds).toEqual([]);
    expect(await env.DB.prepare('SELECT status FROM identity_observations WHERE id=?1').bind(review.observationId).first<string>('status')).toBe(expectedStatus);
    expect(await env.DB.prepare('SELECT state FROM identity_resolution_cases WHERE id=?1').bind(review.caseIds[0]).first<string>('state')).toBe('dismissed');
  });

  it('serializes concurrent revokes with one mutation and one audit', async () => {
    const owner = await person('Concurrent Revoke Owner');
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: `revoke-${owner}@example.test` });
    await ensureActivePersonContactLink(env.DB, { personId: owner, contactPointId: point.id, kind: 'email', source: 'test' });
    const proof = { kind: 'admin', actorPersonId: owner, reasonCode: 'admin_review' } as const;
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: owner, proof });
    const results = await Promise.all([1, 2].map(() => revokeVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, proof })));
    expect(results.sort()).toEqual([false, true]);
    expect(await env.DB.prepare("SELECT count(*) n FROM identity_audit_events WHERE contact_point_id=?1 AND event_type='contact_owner_revoked'").bind(point.id).first<number>('n')).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) n FROM contact_ownership_events WHERE contact_point_id=?1 AND event_type='revoked'").bind(point.id).first<number>('n')).toBe(1);
  });

  it('allows only one transfer-versus-revoke mutation to commit atomically', async () => {
    const one = await person('Race Original');
    const two = await person('Race Target');
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: `race-owner-${one}@example.test` });
    await ensureActivePersonContactLink(env.DB, { personId: one, contactPointId: point.id, kind: 'email', source: 'test' });
    await ensureActivePersonContactLink(env.DB, { personId: two, contactPointId: point.id, kind: 'email', source: 'test' });
    const proof = { kind: 'admin', actorPersonId: one, reasonCode: 'admin_review' } as const;
    await assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: one, proof });
    const settled = await Promise.allSettled([
      assignVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, personId: two, proof, transfer: true }),
      revokeVerifiedContactOwner(env.DB, { campusId: 1, contactPointId: point.id, proof }),
    ]);
    const rejected = settled.filter((result) => result.status === 'rejected');
    expect(rejected.length).toBeLessThanOrEqual(1);
    if (rejected.length === 1) expect(String(rejected[0].reason)).toContain('identity_owner_mutation_conflict');
    if (settled[0].status === 'rejected') expect(settled[1]).toEqual({ status: 'fulfilled', value: true });
    const finalOwner = await env.DB.prepare('SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?1').bind(point.id).first<number>('person_id');
    expect([null, two]).toContain(finalOwner);
    const terminalAudits = await env.DB.prepare("SELECT event_type FROM identity_audit_events WHERE contact_point_id=?1 AND event_type IN ('contact_owner_transferred','contact_owner_revoked')").bind(point.id).all<{ event_type: string }>();
    expect(terminalAudits.results).toHaveLength(1);
  });
});
