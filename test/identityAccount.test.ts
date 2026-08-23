import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  beginContactChange,
  beginRecovery,
  beginSignin,
  beginSignup,
  beginStepUp,
  completeContactChange,
  completeRecoveryRequest,
  completeSigninLink,
  completeStepUp,
  completeVerifiedSignup,
  claimSignupSessionDelivery,
  recentStepUpContext,
} from '../src/lib/identityAccount';
import { ensureActivePersonContactLink, upsertContactPoint } from '../src/lib/identityDb';
import { identityTrustedRequestContext } from '../src/lib/identityAuth';
import { IDENTITY_CANONICAL_REFRESH_LIMIT, refreshIdentityPersonCanonicalKeys } from '../src/lib/identityCanonical';

const authEnv = {
  IDENTITY_VERIFICATION_SECRET: 'identity-account-test-secret-at-least-thirty-two-characters',
  IDENTITY_RECOVERY_KEY_SECRET: 'identity-account-stable-recovery-key-at-least-thirty-two-characters',
  IDENTITY_RECOVERY_KEY_ID: 'v1',
};
let sequence = 610_000;
const now = '2035-01-01 00:00:00';
const later = '2035-01-01 00:01:00';
const requestContext = () => identityTrustedRequestContext(
  new Headers({ 'CF-Connecting-IP': `203.0.113.${++sequence % 240 + 1}` }),
  `identity-account-${sequence}`,
);

async function person(label: string, options: { active?: number; deleted?: boolean; state?: 'active' | 'merged' } = {}) {
  const id = ++sequence; const email = `${label.toLowerCase().replaceAll(' ', '-')}-${id}@example.test`;
  await env.DB.prepare(`INSERT INTO people(id,display_name,email,active,deleted_at,identity_state,auth_disabled_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(id, label, email, options.active ?? 1,
      options.deleted ? '2030-01-01 00:00:00' : null, options.state ?? 'active',
      options.state === 'merged' ? '2030-01-01 00:00:00' : null).run();
  return { id, email };
}

async function verifiedOwner(label: string) {
  const owner = await person(label); const point = await upsertContactPoint(env.DB, { kind: 'email', value: owner.email });
  await ensureActivePersonContactLink(env.DB, { personId: owner.id, contactPointId: point.id, kind: 'email', source: 'test' });
  await env.DB.prepare("INSERT OR REPLACE INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')")
    .bind(point.id, owner.id).run();
  return { ...owner, point };
}

describe('identity account gateway', () => {
  it('begins signup without creating a person and completes one clean verified account exactly once', async () => {
    const before = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: `clean-${++sequence}@example.test`, displayName: 'Clean Signup', requestContext: requestContext(), now });
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(before);
    expect(begun.public).toEqual({ accepted: true, operationId: begun.public.operationId, expiresAt: '2035-01-01 00:10:00' });
    expect(begun.delivery.code).toMatch(/^\d{6}$/);
    const complete = await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
    expect(complete).toMatchObject({ status: 'authenticated', created: true, personId: expect.any(Number) });
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe((before ?? 0) + 1);
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toEqual(complete);
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: '000000', now: later })).toEqual({ status: 'invalid' });
  });

  it('authenticates an existing verified owner without changing their name', async () => {
    const owner = await verifiedOwner('Existing Owner');
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: owner.email, displayName: 'Attacker Supplied Name', requestContext: requestContext(), now });
    const result = await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
    expect(result).toEqual({ status: 'authenticated', personId: owner.id, created: false, sessionEpoch: 0 });
    expect(await env.DB.prepare('SELECT display_name FROM people WHERE id=?1').bind(owner.id).first<string>('display_name')).toBe('Existing Owner');
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: '', now: later })).toEqual({ status: 'invalid' });
  });

  it('binds existing-owner signup at issuance and rejects later transfer without authenticating the replacement', async () => {
    const owner = await verifiedOwner('Bound Signup Owner'); const replacement = await person('Bound Signup Replacement');
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: owner.email, displayName: 'Ignored Bound Name', requestContext: requestContext(), now });
    expect(await env.DB.prepare('SELECT person_id FROM identity_challenges WHERE public_id=?1').bind(begun.delivery.publicId).first<number>('person_id')).toBe(owner.id);
    await ensureActivePersonContactLink(env.DB, { personId: replacement.id, contactPointId: owner.point.id, kind: 'email', source: 'test' });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1').bind(owner.point.id),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(owner.point.id, replacement.id),
    ]);
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toEqual({ status: 'invalid' });
    expect(await env.DB.prepare('SELECT result_person_id FROM identity_account_operations WHERE operation_id=?1').bind(begun.public.operationId).first<number>('result_person_id')).toBeNull();
  });

  it('returns the same completed existing-owner signup result to every concurrent retry', async () => {
    const owner = await verifiedOwner('Concurrent Existing Owner');
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: owner.email, displayName: 'Ignored Concurrent Name', requestContext: requestContext(), now });
    const results = await Promise.all(Array.from({ length: 6 }, () => completeVerifiedSignup(env.DB, authEnv, {
      campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: later,
    })));
    expect(results).toEqual(Array.from({ length: 6 }, () => ({ status: 'authenticated', personId: owner.id, created: false, sessionEpoch: 0 })));
  });

  it('serializes concurrent clean signup completion to one person and one owner', async () => {
    const email = `concurrent-clean-${++sequence}@example.test`;
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email, displayName: 'Concurrent Clean', requestContext: requestContext(), now });
    const results = await Promise.all(Array.from({ length: 6 }, () => completeVerifiedSignup(env.DB, authEnv, {
      campusId: 1, operationId: begun.public.operationId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: later,
    })));
    const people = await env.DB.prepare('SELECT id FROM people WHERE lower(email)=?1').bind(email).all<{ id: number }>();
    expect(people.results).toHaveLength(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM verified_contact_owners o JOIN contact_points c ON c.id=o.contact_point_id
      WHERE c.normalized_value=?1`).bind(email).first<number>('n')).toBe(1);
    expect(new Set(results.filter((result) => result.status === 'authenticated').map((result) => result.personId))).toEqual(new Set([people.results[0].id]));
  });

  it('allows exactly one OTP-bound signup session delivery claim', async () => {
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: `session-claim-${++sequence}@example.test`,
      displayName: `Session Claim ${sequence}`, requestContext: requestContext(), now });
    expect((await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).status).toBe('authenticated');
    expect(await claimSignupSessionDelivery(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: '000000', now: later })).toBeNull();
    const claims = await Promise.all([1, 2].map(() => claimSignupSessionDelivery(env.DB, authEnv, { campusId: 1,
      operationId: begun.public.operationId, publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_session_delivery_claims WHERE operation_id=?1')
      .bind(begun.public.operationId).first<number>('n')).toBe(1);
  });

  it('recovers a pending signup after a fault immediately following OTP consumption', async () => {
    const email = `fault-retry-${++sequence}@example.test`;
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email, displayName: 'Fault Retry', requestContext: requestContext(), now });
    let failed = false;
    const faultDb: AppDb = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (!failed) { failed = true; throw new Error('simulated_post_consume_fault'); }
        return (env.DB as unknown as AppDb).batch(statements);
      },
    };
    expect((await completeVerifiedSignup(faultDb, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).status).toBe('invalid');
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE lower(email)=?1').bind(email).first<number>('n')).toBe(0);
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toMatchObject({ status: 'authenticated', created: true });
  });

  it.each(['shared', 'name', 'soft_deleted', 'legacy', 'household', 'external'] as const)(
    'routes %s signup ambiguity to review without creating a person', async (kind) => {
      const email = `ambiguous-${kind}-${++sequence}@example.test`; const displayName = `Ambiguous ${sequence}`;
      const candidate = await person(displayName, kind === 'soft_deleted' ? { deleted: true } : {});
      if (kind === 'legacy' || kind === 'soft_deleted') await env.DB.prepare('UPDATE people SET email=?1 WHERE id=?2').bind(email, candidate.id).run();
      if (kind === 'shared' || kind === 'household') {
        const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
        if (kind === 'shared') await ensureActivePersonContactLink(env.DB, { personId: candidate.id, contactPointId: point.id, kind: 'email', source: 'test' });
        else {
          const householdId = ++sequence;
          await env.DB.batch([
            env.DB.prepare("INSERT INTO households(id,name) VALUES(?1,'Gateway Household')").bind(householdId),
            env.DB.prepare("INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source) VALUES(1,?1,?2,'test')").bind(householdId, point.id),
          ]);
        }
      }
      if (kind === 'external') await env.DB.prepare(`INSERT INTO identity_observations(campus_id,source,source_key,normalized_email,status)
        VALUES(1,'planning_center',?1,?2,'provisional')`).bind(`external-${sequence}`, email).run();
      const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email, displayName, requestContext: requestContext(), now });
      const before = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
      const result = await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
        publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
      expect(result).toMatchObject({ status: 'review', reviewCaseId: expect.any(Number) });
      expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(before);
    },
  );

  it.each(['giving', 'registration', 'group', 'team', 'newcomer', 'import', 'signup'] as const)(
    'treats a prior %s observation as global signup ambiguity', async (source) => {
      const email = `prior-${source}-${++sequence}@example.test`;
      await env.DB.prepare(`INSERT INTO identity_observations(campus_id,source,source_key,normalized_email,status)
        VALUES(1,?1,?2,?3,'provisional')`).bind(source, `prior-${source}-${sequence}`, email).run();
      const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email, displayName: `Prior ${source} ${sequence}`, requestContext: requestContext(), now });
      expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
        publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toMatchObject({ status: 'review' });
      expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE email=?1').bind(email).first<number>('n')).toBe(0);
    },
  );

  it('treats a household contact in another campus as global signup ambiguity', async () => {
    const email = `cross-household-${++sequence}@example.test`; const campusId = ++sequence; const householdId = ++sequence;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO campuses(id,slug,name) VALUES(?1,?2,?3)').bind(campusId, `household-${campusId}`, 'Other Household Campus'),
      env.DB.prepare("INSERT INTO households(id,name,campus_id) VALUES(?1,'Other Campus Household',?2)").bind(householdId, campusId),
    ]);
    const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await env.DB.prepare("INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source) VALUES(?1,?2,?3,'test')")
      .bind(campusId, householdId, point.id).run();
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email, displayName: 'Cross Household', requestContext: requestContext(), now });
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toMatchObject({ status: 'review' });
  });

  it('keeps signin response neutral while returning delivery only for an eligible verified owner', async () => {
    const owner = await verifiedOwner('Signin Owner');
    const known = await beginSignin(env.DB, authEnv, { campusId: 1, email: owner.email, requestContext: requestContext(), now });
    const unknown = await beginSignin(env.DB, authEnv, { campusId: 1, email: `unknown-${++sequence}@example.test`, requestContext: requestContext(), now });
    expect(known.public).toEqual(unknown.public);
    expect(known.delivery).toMatchObject({ to: owner.email, token: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/) });
    expect(unknown.delivery).toBeNull();
    expect(await completeSigninLink(env.DB, authEnv, { campusId: 1, publicId: known.delivery!.publicId, token: known.delivery!.token, now: later }))
      .toMatchObject({ status: 'authenticated', personId: owner.id, sessionEpoch: 0 });
    expect((await completeSigninLink(env.DB, authEnv, { campusId: 1, publicId: known.delivery!.publicId, token: known.delivery!.token, now: later })).status).toBe('invalid');
  });

  it('binds login to the owner at issuance and rejects later owner transfer or campus revocation', async () => {
    const owner = await verifiedOwner('Bound Signin Owner'); const replacement = await person('Bound Signin Replacement');
    const first = await beginSignin(env.DB, authEnv, { campusId: 1, email: owner.email, requestContext: requestContext(), now });
    expect(await env.DB.prepare('SELECT person_id FROM identity_challenges WHERE public_id=?1').bind(first.delivery!.publicId).first<number>('person_id')).toBe(owner.id);
    await ensureActivePersonContactLink(env.DB, { personId: replacement.id, contactPointId: owner.point.id, kind: 'email', source: 'test' });
    await env.DB.batch([
      env.DB.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1').bind(owner.point.id),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(owner.point.id, replacement.id),
    ]);
    expect((await completeSigninLink(env.DB, authEnv, { campusId: 1, publicId: first.delivery!.publicId,
      token: first.delivery!.token, now: later })).status).toBe('invalid');

    const secondOwner = await verifiedOwner('Campus Revoked Signin Owner');
    const second = await beginSignin(env.DB, authEnv, { campusId: 1, email: secondOwner.email, requestContext: requestContext(), now });
    await env.DB.prepare('UPDATE campus_memberships SET active=0 WHERE campus_id=1 AND person_id=?1').bind(secondOwner.id).run();
    expect((await completeSigninLink(env.DB, authEnv, { campusId: 1, publicId: second.delivery!.publicId,
      token: second.delivery!.token, now: later })).status).toBe('invalid');
    const unknown = await beginSignin(env.DB, authEnv, { campusId: 1, email: `bound-unknown-${++sequence}@example.test`, requestContext: requestContext(), now });
    const unknownChallenge = await env.DB.prepare('SELECT person_id FROM identity_challenges WHERE public_id=(SELECT public_id FROM identity_challenges ORDER BY id DESC LIMIT 1)')
      .first<number>('person_id');
    expect(unknown.delivery).toBeNull();
    expect(unknownChallenge).toBeNull();
    const otherCampus = ++sequence;
    await env.DB.prepare('INSERT INTO campuses(id,slug,name) VALUES(?1,?2,?3)').bind(otherCampus, `signin-${otherCampus}`, 'Signin Other Campus').run();
    const crossCampus = await beginSignin(env.DB, authEnv, { campusId: otherCampus, email: owner.email, requestContext: requestContext(), now });
    expect(crossCampus.public).toEqual(unknown.public);
    expect(crossCampus.delivery).toBeNull();
  });

  it('step-up is bound to the current verified owner and is single-use', async () => {
    const owner = await verifiedOwner('Step Up Owner'); const other = await verifiedOwner('Step Up Other');
    const begun = await beginStepUp(env.DB, authEnv, { campusId: 1, personId: owner.id, requestContext: requestContext(), now });
    expect(begun.delivery.to).toBe(owner.email);
    expect((await completeStepUp(env.DB, authEnv, { campusId: 1, personId: other.id, publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).status).toBe('invalid');
    const completed = await completeStepUp(env.DB, authEnv, { campusId: 1, personId: owner.id, publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
    expect(completed).toMatchObject({ status: 'verified', personId: owner.id, authMethod: 'email_otp', stepUpTime: expect.any(Number) });
    expect((await completeStepUp(env.DB, authEnv, { campusId: 1, personId: owner.id, publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).status).toBe('invalid');
  });

  it('rechecks campus membership before consuming a step-up challenge', async () => {
    const owner = await verifiedOwner('Revoked Step Up Owner');
    const begun = await beginStepUp(env.DB, authEnv, { campusId: 1, personId: owner.id, requestContext: requestContext(), now });
    await env.DB.prepare('UPDATE campus_memberships SET active=0 WHERE campus_id=1 AND person_id=?1').bind(owner.id).run();
    expect((await completeStepUp(env.DB, authEnv, { campusId: 1, personId: owner.id, publicId: begun.delivery.publicId,
      code: begun.delivery.code, now: later })).status).toBe('invalid');
    expect(await env.DB.prepare('SELECT consumed_at FROM identity_challenges WHERE public_id=?1').bind(begun.delivery.publicId).first<string>('consumed_at')).toBeNull();
  });

  it('database-guards step-up consumption when membership is revoked after the application check', async () => {
    const owner = await verifiedOwner('DB Guarded Step Up Owner');
    const begun = await beginStepUp(env.DB, authEnv, { campusId: 1, personId: owner.id, requestContext: requestContext(), now });
    await env.DB.prepare('UPDATE campus_memberships SET active=0 WHERE campus_id=1 AND person_id=?1').bind(owner.id).run();
    await expect(env.DB.prepare("UPDATE identity_challenges SET consumed_at=?1 WHERE public_id=?2")
      .bind(later, begun.delivery.publicId).run()).rejects.toThrow();
    expect(await env.DB.prepare('SELECT consumed_at FROM identity_challenges WHERE public_id=?1')
      .bind(begun.delivery.publicId).first<string>('consumed_at')).toBeNull();
  });

  it('keeps Unicode/NFKC name collisions in review while allowing a clean Chinese name', async () => {
    await person('Alice\u0301 张');
    const collision = await beginSignup(env.DB, authEnv, { campusId: 1, email: `unicode-collision-${++sequence}@example.test`,
      displayName: 'Alicé 张', requestContext: requestContext(), now });
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: collision.public.operationId,
      publicId: collision.delivery.publicId, code: collision.delivery.code, now: later })).toMatchObject({ status: 'review' });
    const clean = await beginSignup(env.DB, authEnv, { campusId: 1, email: `unicode-clean-${++sequence}@example.test`,
      displayName: '宋雷欧', requestContext: requestContext(), now });
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: clean.public.operationId,
      publicId: clean.delivery.publicId, code: clean.delivery.code, now: later })).toMatchObject({ status: 'authenticated', created: true });
  });

  it.each([
    ['Foo-Bar', 'Foo Bar'],
    ['张三·李', '张三 李'],
  ])('uses exact application name normalization for %s', async (legacyName, signupName) => {
    await person(legacyName);
    const refresh = await refreshIdentityPersonCanonicalKeys(env.DB);
    expect(refresh.complete).toBe(true);
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: `canonical-name-${++sequence}@example.test`,
      displayName: signupName, requestContext: requestContext(), now });
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toMatchObject({ status: 'review' });
  });

  it('uses exact NFC and Unicode casing for legacy email keys', async () => {
    const legacy = await person('Canonical Email Owner');
    await env.DB.prepare('UPDATE people SET email=?1 WHERE id=?2').bind('U\u0308SER@Example.Test', legacy.id).run();
    expect((await refreshIdentityPersonCanonicalKeys(env.DB)).complete).toBe(true);
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: 'üser@example.test', displayName: `Distinct ${++sequence}`,
      requestContext: requestContext(), now });
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toMatchObject({ status: 'review' });
  });

  it('refreshes only a bounded stale-key batch and reviews while untrusted rows remain', async () => {
    const statements = Array.from({ length: IDENTITY_CANONICAL_REFRESH_LIMIT + 1 }, (_, index) => {
      const id = ++sequence;
      return env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
        .bind(id, `Stale Canonical ${index}`, `stale-canonical-${id}@example.test`);
    });
    await env.DB.batch(statements);
    const begun = await beginSignup(env.DB, authEnv, { campusId: 1, email: `stale-review-${++sequence}@example.test`,
      displayName: `Safe Unique ${sequence}`, requestContext: requestContext(), now });
    expect(await completeVerifiedSignup(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toMatchObject({ status: 'review' });
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_person_canonical_keys WHERE is_current=0 OR normalization_version<>1')
      .first<number>('n')).toBeGreaterThan(0);
  });

  it('refuses sensitive account operations for a person outside the selected campus', async () => {
    const owner = await verifiedOwner('Cross Campus Step Up'); const campusId = ++sequence;
    await env.DB.prepare('INSERT INTO campuses(id,slug,name) VALUES(?1,?2,?3)').bind(campusId, `step-${campusId}`, 'Step Campus').run();
    await expect(beginStepUp(env.DB, authEnv, { campusId, personId: owner.id, requestContext: requestContext(), now }))
      .rejects.toThrow('identity_step_up_unavailable');
    const context = recentStepUpContext(owner.id, { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp',
      authTime: 2_051_222_400, stepUpTime: 2_051_222_400 }, 2_051_222_400);
    await expect(beginContactChange(env.DB, authEnv, { campusId, personId: owner.id, newEmail: `outside-campus-${sequence}@example.test`,
      recentStepUp: context, requestContext: requestContext(), now })).rejects.toThrow('identity_contact_change_unavailable');
  });

  it('requires branded recent step-up and blocks contact takeover through an owned or shared address', async () => {
    const owner = await verifiedOwner('Contact Owner'); const attacker = await verifiedOwner('Contact Attacker');
    const context = recentStepUpContext(owner.id, {
      schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp', authTime: 2_051_222_400, stepUpTime: 2_051_222_400,
    }, 2_051_222_400);
    const takeover = await beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail: attacker.email, recentStepUp: context, requestContext: requestContext(), now });
    const blocked = await completeContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, operationId: takeover.public.operationId,
      publicId: takeover.delivery.publicId, code: takeover.delivery.code, now: later });
    expect(blocked.status).toBe('review');
    expect((await env.DB.prepare('SELECT email FROM people WHERE id=?1').bind(owner.id).first<string>('email'))).toBe(owner.email);
    expect(await completeContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, operationId: takeover.public.operationId,
      publicId: takeover.delivery.publicId, code: '000000', now: later })).toEqual({ status: 'invalid' });
    await expect(beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail: `forged-${sequence}@example.test`,
      recentStepUp: {} as never, requestContext: requestContext(), now })).rejects.toThrow('identity_recent_step_up_required');
  });

  it('expires branded recent step-up context at ten minutes and rejects future assurance', async () => {
    const owner = await verifiedOwner('Freshness Contact Owner'); const base = 2_051_222_400;
    const assurance = { schemaVersion: 2 as const, sessionId: crypto.randomUUID(), authMethod: 'email_otp' as const, authTime: base, stepUpTime: base };
    const context = recentStepUpContext(owner.id, assurance, base);
    await expect(beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail: `fresh-boundary-${++sequence}@example.test`,
      recentStepUp: context, requestContext: requestContext(), now: '2035-01-01 00:10:00' })).resolves.toBeTruthy();
    await expect(beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail: `stale-context-${++sequence}@example.test`,
      recentStepUp: context, requestContext: requestContext(), now: '2035-01-01 00:10:01' })).rejects.toThrow('identity_recent_step_up_required');
    expect(() => recentStepUpContext(owner.id, { ...assurance, authTime: base + 1, stepUpTime: base + 1 }, base))
      .toThrow('identity_recent_step_up_required');
  });

  it('changes a clean contact atomically, bumps sessions, and returns an old-contact notification', async () => {
    const owner = await verifiedOwner('Clean Contact Owner');
    const context = recentStepUpContext(owner.id, { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'magic_link',
      authTime: 2_051_222_400, stepUpTime: 2_051_222_400 }, 2_051_222_400);
    const begun = await beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail: `new-${++sequence}@example.test`,
      recentStepUp: context, requestContext: requestContext(), now });
    const result = await completeContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
    expect(result).toMatchObject({ status: 'changed', personId: owner.id, sessionEpoch: 1, notifyOldContact: { to: owner.email } });
    expect((await env.DB.prepare('SELECT email FROM people WHERE id=?1').bind(owner.id).first<string>('email'))).toBe(begun.delivery.to);
    expect(await completeContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: '000000', now: later })).toEqual({ status: 'invalid' });
    expect(await completeContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).toEqual(result);
  });

  it('routes a contact change to review when the current owner becomes stale after issuance', async () => {
    const owner = await verifiedOwner('Stale Contact Owner');
    const context = recentStepUpContext(owner.id, { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp',
      authTime: 2_051_222_400, stepUpTime: 2_051_222_400 }, 2_051_222_400);
    const begun = await beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail: `stale-new-${++sequence}@example.test`,
      recentStepUp: context, requestContext: requestContext(), now });
    await env.DB.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1 AND person_id=?2').bind(owner.point.id, owner.id).run();
    const result = await completeContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
    expect(result).toMatchObject({ status: 'review', reviewCaseId: expect.any(Number) });
    expect(await env.DB.prepare('SELECT email FROM people WHERE id=?1').bind(owner.id).first<string>('email')).toBe(owner.email);
  });

  it('revalidates campus membership when completing a contact change', async () => {
    const owner = await verifiedOwner('Campus Revoked Contact Owner');
    const context = recentStepUpContext(owner.id, { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp',
      authTime: 2_051_222_400, stepUpTime: 2_051_222_400 }, 2_051_222_400);
    const begun = await beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail: `campus-revoked-${++sequence}@example.test`,
      recentStepUp: context, requestContext: requestContext(), now });
    await env.DB.prepare('UPDATE campus_memberships SET active=0 WHERE campus_id=1 AND person_id=?1').bind(owner.id).run();
    const result = await completeContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
    expect(result).toMatchObject({ status: 'review', reviewCaseId: expect.any(Number) });
    expect(await env.DB.prepare('SELECT email FROM people WHERE id=?1').bind(owner.id).first<string>('email')).toBe(owner.email);
  });

  it('rolls back every contact mutation when session epoch changes immediately before the transaction', async () => {
    const owner = await verifiedOwner('Epoch Interleaving Owner'); const newEmail = `epoch-interleave-${++sequence}@example.test`;
    const context = recentStepUpContext(owner.id, { schemaVersion: 2, sessionId: crypto.randomUUID(), authMethod: 'email_otp',
      authTime: 2_051_222_400, stepUpTime: 2_051_222_400 }, 2_051_222_400);
    const begun = await beginContactChange(env.DB, authEnv, { campusId: 1, personId: owner.id, newEmail,
      recentStepUp: context, requestContext: requestContext(), now });
    let injected = false;
    const interleaved: AppDb = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (!injected) {
          injected = true;
          await env.DB.prepare('UPDATE people SET session_epoch=session_epoch+1 WHERE id=?1').bind(owner.id).run();
        }
        return (env.DB as unknown as AppDb).batch(statements);
      },
    };
    expect((await completeContactChange(interleaved, authEnv, { campusId: 1, personId: owner.id, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).status).not.toBe('changed');
    const newPoint = await env.DB.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?1").bind(newEmail).first<number>('id');
    expect(await env.DB.prepare('SELECT count(*) n FROM person_contact_links WHERE person_id=?1 AND contact_point_id=?2').bind(owner.id, newPoint).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM verified_contact_owners WHERE contact_point_id=?1').bind(newPoint).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_account_proof_uses WHERE operation_id=?1').bind(begun.public.operationId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_session_epoch_claims WHERE operation_id=?1').bind(begun.public.operationId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT state FROM identity_account_operations WHERE operation_id=?1').bind(begun.public.operationId).first<string>('state')).toBe('pending');
  });

  it('enforces UTF-8 byte limits for signup names at the exact multibyte boundary', async () => {
    await expect(beginSignup(env.DB, authEnv, { campusId: 1, email: `utf8-ok-${++sequence}@example.test`, displayName: '界'.repeat(170),
      requestContext: requestContext(), now })).resolves.toBeTruthy();
    await expect(beginSignup(env.DB, authEnv, { campusId: 1, email: `utf8-too-long-${++sequence}@example.test`, displayName: '界'.repeat(171),
      requestContext: requestContext(), now })).rejects.toThrow('identity_signup_invalid');
  });

  it('creates one idempotent high-risk recovery case and never transfers ownership', async () => {
    const owner = await verifiedOwner('Recovery Owner'); const newEmail = `recovery-new-${++sequence}@example.test`;
    const known = await beginRecovery(env.DB, authEnv, { campusId: 1, accountEmail: owner.email, reachableEmail: newEmail, requestContext: requestContext(), now });
    const unknown = await beginRecovery(env.DB, authEnv, { campusId: 1, accountEmail: `missing-${sequence}@example.test`, reachableEmail: `other-${sequence}@example.test`, requestContext: requestContext(), now });
    expect(known.public.accepted).toBe(unknown.public.accepted);
    const completed = await completeRecoveryRequest(env.DB, authEnv, { campusId: 1, operationId: known.public.operationId,
      publicId: known.delivery.publicId, code: known.delivery.code, now: later });
    expect(completed).toMatchObject({ status: 'review', recoveryCaseId: expect.any(Number) });
    expect(await completeRecoveryRequest(env.DB, authEnv, { campusId: 1, operationId: known.public.operationId,
      publicId: known.delivery.publicId, code: known.delivery.code, now: later })).toEqual(completed);
    expect(await completeRecoveryRequest(env.DB, authEnv, { campusId: 1, operationId: known.public.operationId,
      publicId: known.delivery.publicId, code: '000000', now: later })).toEqual({ status: 'invalid' });
    expect((await env.DB.prepare('SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?1').bind(owner.point.id).first<number>('person_id'))).toBe(owner.id);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_audit_events WHERE metadata_json LIKE ?1').bind(`%${newEmail}%`).first<number>('n')).toBe(0);
  });

  it('rolls back the recovery case when its durable notification cannot be enqueued', async () => {
    const owner = await verifiedOwner('Atomic Recovery Notice Owner');
    const begun = await beginRecovery(env.DB, authEnv, { campusId: 1, accountEmail: owner.email,
      reachableEmail: `atomic-recovery-${++sequence}@example.test`, requestContext: requestContext(), now });
    await env.DB.prepare(`CREATE TRIGGER test_recovery_outbox_abort BEFORE INSERT ON identity_recovery_notification_outbox
      BEGIN SELECT RAISE(ABORT,'test_recovery_outbox_abort'); END`).run();
    try {
      await expect(completeRecoveryRequest(env.DB, authEnv, { campusId: 1, operationId: begun.public.operationId,
        publicId: begun.delivery.publicId, code: begun.delivery.code, now: later })).resolves.toEqual({ status: 'invalid' });
    } finally {
      await env.DB.prepare('DROP TRIGGER test_recovery_outbox_abort').run();
    }
    expect(await env.DB.prepare('SELECT state,result_case_id FROM identity_account_operations WHERE operation_id=?1')
      .bind(begun.public.operationId).first()).toEqual({ state: 'pending', result_case_id: null });
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_recovery_cases WHERE source_operation_id=?1')
      .bind(begun.public.operationId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_account_proof_uses WHERE operation_id=?1')
      .bind(begun.public.operationId).first<number>('n')).toBe(0);
  });

  it('does not attach a recovery case to an owner outside the selected campus', async () => {
    const owner = await verifiedOwner('Other Campus Recovery Owner'); const campusId = ++sequence;
    await env.DB.prepare('INSERT INTO campuses(id,slug,name) VALUES(?1,?2,?3)').bind(campusId, `recovery-${campusId}`, 'Recovery Campus').run();
    const begun = await beginRecovery(env.DB, authEnv, { campusId, accountEmail: owner.email,
      reachableEmail: `cross-campus-recovery-${sequence}@example.test`, requestContext: requestContext(), now });
    const completed = await completeRecoveryRequest(env.DB, authEnv, { campusId, operationId: begun.public.operationId,
      publicId: begun.delivery.publicId, code: begun.delivery.code, now: later });
    expect(completed.status).toBe('review');
    const caseId = completed.status === 'review' ? completed.recoveryCaseId : 0;
    expect(await env.DB.prepare('SELECT person_id FROM identity_recovery_cases WHERE id=?1').bind(caseId).first<number>('person_id')).toBeNull();
  });
});
