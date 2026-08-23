import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { identityTrustedRequestContext } from '../src/lib/identityAuth';
import { beginSignup, completeVerifiedSignup } from '../src/lib/identityAccount';
import {
  beginTeamApplicationIntent,
  claimTeamApplicationSessionDelivery,
  completeTeamApplicationIntent,
  createGroupMemberObservation,
  createNewcomerObservationIntent,
  consumeSignedInTeamApplicationIntent,
} from '../src/lib/identityBusinessIntent';
import { createGroup } from '../src/lib/groupDb';
import { ensureActivePersonContactLink, upsertContactPoint } from '../src/lib/identityDb';
import { identityGatewaySessionContext } from '../src/lib/identityGateway';
import { registerIdentitySource } from '../src/lib/identityGateway';

const vars = {
  IDENTITY_VERIFICATION_SECRET: 'business-intent-verification-secret-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_SECRET: 'business-intent-stable-source-key-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
};
let sequence = 1_570_000_000;
const next = () => ++sequence;
const requestContext = () => identityTrustedRequestContext(
  new Headers({ 'CF-Connecting-IP': '203.0.113.157' }), `business-intent-${next()}`,
);

async function team() {
  const id = next();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO teams(id,sort) VALUES(?1,0)').bind(id),
    env.DB.prepare("INSERT INTO team_i18n(team_id,locale,name) VALUES(?1,'en',?2)").bind(id, `Intent Team ${id}`),
  ]);
  return id;
}

async function member() {
  const id = next(); const now = '2032-01-01 00:00:00';
  const begun = await beginSignup(env.DB, vars, { campusId: 1, displayName: `Intent Member ${id}`,
    email: `intent-member-${id}@example.test`, requestContext: requestContext(), now });
  const completed = await completeVerifiedSignup(env.DB, vars, { campusId: 1, operationId: begun.public.operationId,
    publicId: begun.delivery.publicId, code: begun.delivery.code, now: '2032-01-01 00:01:00' });
  if (completed.status !== 'authenticated') throw new Error('test member unavailable');
  return completed.personId;
}

describe('identity business Team adapter', () => {
  it('creates no person or application before OTP, then consumes the exact source once after clean signup', async () => {
    const teamId = await team(); const intentId = crypto.randomUUID();
    const peopleBefore = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    const begun = await beginTeamApplicationIntent(env.DB, vars, {
      campusId: 1, intentId, teamId, positionId: null, message: 'I can help',
      name: 'Fresh Volunteer', email: `fresh-${next()}@example.test`, phone: null,
      requestContext: requestContext(), now: '2032-01-01 00:00:00',
    });
    expect(begun.status).toBe('verification_required');
    expect(await env.DB.prepare('SELECT count(*) n FROM team_applications').first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(peopleBefore);
    const result = await completeTeamApplicationIntent(env.DB, vars, {
      campusId: 1, intentId, publicId: begun.status === 'verification_required' ? begun.delivery.publicId : '',
      code: begun.status === 'verification_required' ? begun.delivery.code : '', now: '2032-01-01 00:01:00',
    });
    expect(result).toMatchObject({ status: 'consumed', createdIdentity: true });
    expect(await env.DB.prepare('SELECT count(*) n FROM team_applications WHERE team_id=?1')
      .bind(teamId).first<number>('n')).toBe(1);
    const session = await claimTeamApplicationSessionDelivery(env.DB, vars, {
      campusId: 1, intentId, publicId: begun.status === 'verification_required' ? begun.delivery.publicId : '',
      code: begun.status === 'verification_required' ? begun.delivery.code : '',
    });
    expect(session?.personId).toBe(result.status === 'consumed' ? result.personId : -1);
    expect(await claimTeamApplicationSessionDelivery(env.DB, vars, {
      campusId: 1, intentId, publicId: begun.status === 'verification_required' ? begun.delivery.publicId : '',
      code: begun.status === 'verification_required' ? begun.delivery.code : '',
    })).toBeNull();
    const replay = await completeTeamApplicationIntent(env.DB, vars, {
      campusId: 1, intentId, publicId: begun.status === 'verification_required' ? begun.delivery.publicId : '',
      code: begun.status === 'verification_required' ? begun.delivery.code : '', now: '2032-01-01 00:02:00',
    });
    expect(replay).toMatchObject({ status: 'consumed', applicationId: result.status === 'consumed' ? result.applicationId : -1 });
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_business_intent_receipts WHERE intent_id=?1')
      .bind(intentId).first<number>('n')).toBe(1);
    await expect(env.DB.prepare('UPDATE identity_business_intents SET business_record_key=?1 WHERE intent_id=?2')
      .bind('forged-result', intentId).run()).rejects.toThrow(/result_immutable/);
  });

  it('attaches a signed-in canonical member and consumes concurrent retries into one pending application', async () => {
    const teamId = await team(); const personId = await member(); const intentId = crypto.randomUUID();
    const input = {
      campusId: 1, intentId, teamId, positionId: null, message: 'Signed application',
      session: identityGatewaySessionContext({ personId, campusId: 1, sessionEpoch: 0 }),
      name: 'Victim Name', email: 'victim@example.test', phone: '+12125550123',
    };
    const results = await Promise.all([
      consumeSignedInTeamApplicationIntent(env.DB, vars, input),
      consumeSignedInTeamApplicationIntent(env.DB, vars, input),
    ]);
    expect(results.every((result) => result.status === 'consumed')).toBe(true);
    expect(new Set(results.map((result) => result.applicationId))).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) n FROM team_applications WHERE person_id=?1 AND team_id=?2 AND status='P'")
      .bind(personId, teamId).first<number>('n')).toBe(1);
    const duplicate = await consumeSignedInTeamApplicationIntent(env.DB, vars, {
      campusId: 1, intentId: crypto.randomUUID(), teamId, positionId: null, message: 'Different retry payload',
      session: identityGatewaySessionContext({ personId, campusId: 1, sessionEpoch: 0 }),
    });
    expect(duplicate.applicationId).toBe(results[0].applicationId);
    const observed = await env.DB.prepare(`SELECT o.normalized_email,o.normalized_name FROM identity_business_intents bi
      JOIN identity_source_records s ON s.id=bi.source_record_id JOIN identity_observations o ON o.id=s.observation_id
      WHERE bi.intent_id=?1`).bind(intentId).first<{ normalized_email: string; normalized_name: string }>();
    expect(observed?.normalized_email).toMatch(/^intent-member-/);
    expect(observed?.normalized_email).not.toBe('victim@example.test');
  });

  it('reserves one signup operation when anonymous begins race', async () => {
    const teamId = await team(); const intentId = crypto.randomUUID();
    const input = {
      campusId: 1, intentId, teamId, positionId: null, message: null,
      name: 'Racing Volunteer', email: `racing-${next()}@example.test`, phone: null,
      requestContext: requestContext(), now: '2032-01-01 00:00:00',
    };
    const results = await Promise.all([
      beginTeamApplicationIntent(env.DB, vars, input),
      beginTeamApplicationIntent(env.DB, vars, input),
    ]);
    expect(results.filter((result) => result.status === 'verification_required')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_account_operations WHERE operation_id=?1')
      .bind(intentId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_challenges c JOIN contact_points cp ON cp.id=c.contact_point_id
      WHERE c.purpose='signup' AND cp.normalized_value=?1`).bind(input.email).first<number>('n')).toBe(1);
  });

  it('fails closed on cross-campus intent substitution and stale payload drift', async () => {
    const teamId = await team(); const intentId = crypto.randomUUID();
    const input = { campusId: 1, intentId, teamId, positionId: null, message: 'Exact message',
      name: 'Exact Volunteer', email: `exact-${next()}@example.test`, phone: null, requestContext: requestContext() };
    await beginTeamApplicationIntent(env.DB, vars, input);
    await expect(beginTeamApplicationIntent(env.DB, vars, { ...input, message: 'Changed message' }))
      .rejects.toThrow(/identity_business_intent_payload_drift/);
    await expect(completeTeamApplicationIntent(env.DB, vars, { campusId: next(), intentId, publicId: crypto.randomUUID(), code: '000000' }))
      .resolves.toEqual({ status: 'invalid' });
  });

  it('rejects expired completion and freezes child payload and terminal result', async () => {
    const teamId = await team(); const intentId = crypto.randomUUID();
    const begun = await beginTeamApplicationIntent(env.DB, vars, {
      campusId: 1, intentId, teamId, positionId: null, message: 'Frozen payload', name: 'Expiry Person',
      email: `expiry-${next()}@example.test`, phone: null, requestContext: requestContext(), now: '2032-01-01 00:00:00',
    });
    expect(begun.status).toBe('verification_required');
    await expect(env.DB.prepare('UPDATE identity_team_application_intents SET message=?1 WHERE intent_id=?2')
      .bind('tampered', intentId).run()).rejects.toThrow(/immutable/);
    const expired = await completeTeamApplicationIntent(env.DB, vars, {
      campusId: 1, intentId, publicId: begun.status === 'verification_required' ? begun.delivery.publicId : '',
      code: begun.status === 'verification_required' ? begun.delivery.code : '', now: '2032-01-01 00:16:00',
    });
    expect(expired).toEqual({ status: 'invalid' });
    expect(await env.DB.prepare('SELECT count(*) n FROM team_applications WHERE team_id=?1').bind(teamId).first<number>('n')).toBe(0);
  });

  it('DB guard rejects attacker signup substitution and forged pre-proof receipt', async () => {
    const teamId = await team(); const intentId = crypto.randomUUID(); const reservationId = intentId;
    const sourceDigest = 'a'.repeat(64);
    const source = await registerIdentitySource(env.DB, vars, { campusId: 1, source: 'team', sourceRecordKey: intentId,
      email: `victim-${next()}@example.test`, phone: null, name: 'Victim Name', attachmentPolicy: 'signed_in_or_claim', sourceDigest });
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO identity_business_intents(intent_id,campus_id,kind,source_record_id,source_version,
        source_digest,payload_digest,signup_reservation_id,expires_at) VALUES(?1,1,'team_application',?2,?3,?4,?4,?5,'2032-01-01 00:15:00')`)
        .bind(intentId, source.sourceRecordId, source.version, sourceDigest, reservationId),
      env.DB.prepare('INSERT INTO identity_team_application_intents(intent_id,team_id) VALUES(?1,?2)').bind(intentId, teamId),
    ]);
    const attacker = await beginSignup(env.DB, vars, { campusId: 1, email: `attacker-${next()}@example.test`,
      displayName: 'Attacker Name', requestContext: requestContext(), now: '2032-01-01 00:00:00', reservedOperationId: reservationId });
    await expect(env.DB.prepare('UPDATE identity_business_intents SET signup_operation_id=?1 WHERE intent_id=?2')
      .bind(attacker.public.operationId, intentId).run()).rejects.toThrow(/signup_binding_invalid/);
    await expect(env.DB.prepare(`INSERT INTO identity_business_intent_receipts(receipt_id,campus_id,intent_id,source_record_id,
      source_version,source_digest,person_id,business_record_key) VALUES(?1,1,?2,?3,?4,?5,NULL,'forged')`)
      .bind(crypto.randomUUID(), intentId, source.sourceRecordId, source.version, sourceDigest).run())
      .rejects.toThrow(/receipt_invalid/);
  });
});

describe('identity business Newcomer adapter', () => {
  const intake = (email: string) => ({
    name: 'Newcomer Observer', email, phone: null, locale: 'en' as const, visitDate: '2032-01-01',
    serviceTypeId: null, contactConsent: true, answers: [],
  });

  it('creates one inactive auth-disabled notification profile and exact bound submission', async () => {
    const intentId = crypto.randomUUID(); const email = `newcomer-${next()}@example.test`;
    const input = {
      campusId: 1, intentId, backend: 'd1', intake: intake(email),
    } as const;
    const [result, replay] = await Promise.all([
      createNewcomerObservationIntent(env.DB, vars, input),
      createNewcomerObservationIntent(env.DB, vars, input),
    ]);
    expect(result).toMatchObject({ status: 'consumed', submissionId: intentId });
    expect(replay).toMatchObject({ status: 'consumed', submissionId: intentId });
    expect(result.status === 'consumed' && replay.status === 'consumed'
      ? replay.provisionalPersonId : null).toBe(result.status === 'consumed' ? result.provisionalPersonId : null);
    expect([result, replay].filter((item) => item.status === 'consumed' && item.createdProvisional)).toHaveLength(1);
    const person = await env.DB.prepare(`SELECT active,identity_state,auth_disabled_at FROM people WHERE id=?1`)
      .bind(result.status === 'consumed' ? result.provisionalPersonId : 0)
      .first<{ active: number; identity_state: string; auth_disabled_at: string | null }>();
    expect(person).toMatchObject({ active: 0, identity_state: 'provisional' });
    expect(person?.auth_disabled_at).not.toBeNull();
    expect(await env.DB.prepare(`SELECT count(*) n FROM verified_contact_owners o JOIN contact_points cp ON cp.id=o.contact_point_id
      WHERE cp.normalized_value=?1`).bind(email).first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT count(*) n FROM newcomer_submissions n JOIN identity_source_records s
      ON s.id=n.identity_source_record_id WHERE n.id=?1 AND n.linked_person_id=s.provisional_person_id
        AND s.state='unlinked' AND s.linked_person_id IS NULL`).bind(intentId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM newcomer_submissions WHERE id=?1').bind(intentId).first<number>('n')).toBe(1);
  });

  it('sends a verified/shared contact to review without a submission or second person', async () => {
    const personId = await member(); const ownerEmail = await env.DB.prepare('SELECT email FROM people WHERE id=?1')
      .bind(personId).first<string>('email');
    const intentId = crypto.randomUUID(); const before = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    const result = await createNewcomerObservationIntent(env.DB, vars, {
      campusId: 1, intentId, backend: 'd1', intake: intake(ownerEmail ?? ''),
    });
    expect(result).toEqual({ status: 'review' });
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(before);
    expect(await env.DB.prepare('SELECT count(*) n FROM newcomer_submissions WHERE id=?1').bind(intentId).first<number>('n')).toBe(0);
  });

  it('sends an unverified person-linked contact to review without a duplicate provisional person', async () => {
    const personId = next(); const email = `shared-unverified-${next()}@example.test`;
    await env.DB.prepare(`INSERT INTO people(id,display_name,email,role,active,identity_state)
      VALUES(?1,'Existing Shared Contact',?2,'member',1,'active')`).bind(personId, `existing-${email}`).run();
    const contact = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId, contactPointId: contact.id, kind: 'email', source: 'test' });
    const intentId = crypto.randomUUID(); const before = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    expect(await createNewcomerObservationIntent(env.DB, vars, {
      campusId: 1, intentId, backend: 'd1', intake: intake(email),
    })).toEqual({ status: 'review' });
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(before);
    expect(await env.DB.prepare('SELECT count(*) n FROM newcomer_submissions WHERE id=?1').bind(intentId).first<number>('n')).toBe(0);
  });

  it('sends a household-linked contact to review without a duplicate provisional person', async () => {
    const householdId = next(); const email = `shared-household-${next()}@example.test`;
    const contact = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households(id,name) VALUES(?1,'Shared Observation Household')").bind(householdId),
      env.DB.prepare(`INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source)
        VALUES(1,?1,?2,'test')`).bind(householdId, contact.id),
    ]);
    const intentId = crypto.randomUUID(); const before = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    expect(await createNewcomerObservationIntent(env.DB, vars, {
      campusId: 1, intentId, backend: 'd1', intake: intake(email),
    })).toEqual({ status: 'review' });
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(before);
    expect(await env.DB.prepare('SELECT count(*) n FROM newcomer_submissions WHERE id=?1').bind(intentId).first<number>('n')).toBe(0);
  });

  it('serializes two sources for one clean contact into one provisional person and one review', async () => {
    const email = `racing-observation-${next()}@example.test`;
    const peopleBefore = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    const results = await Promise.all([
      createNewcomerObservationIntent(env.DB, vars, { campusId: 1, intentId: crypto.randomUUID(), backend: 'd1', intake: intake(email) }),
      createNewcomerObservationIntent(env.DB, vars, { campusId: 1, intentId: crypto.randomUUID(), backend: 'd1', intake: intake(email) }),
    ]);
    expect(results.filter((result) => result.status === 'consumed')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'review')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(peopleBefore + 1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM newcomer_submissions n JOIN identity_source_records s
      ON s.id=n.identity_source_record_id JOIN identity_observations o ON o.id=s.observation_id
      WHERE o.normalized_email=?1`).bind(email).first<number>('n')).toBe(1);
  });

  it('keeps legacy person linking mutable but rejects retrofitting an identity source', async () => {
    const personId = await member();
    const submissionId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO newcomer_submissions(id,name,locale,visit_date,source,status_id)
      VALUES(?1,'Legacy Newcomer','en','2032-01-01','staff',1)`).bind(submissionId).run();
    await expect(env.DB.prepare('UPDATE newcomer_submissions SET linked_person_id=?1 WHERE id=?2')
      .bind(personId, submissionId).run()).resolves.toMatchObject({ meta: { changes: 1 } });

    const source = await registerIdentitySource(env.DB, vars, {
      campusId: 1, source: 'newcomer', sourceRecordKey: crypto.randomUUID(),
      email: `legacy-retrofit-${next()}@example.test`, phone: null, name: 'Legacy Retrofit',
      attachmentPolicy: 'observation_only', sourceDigest: 'c'.repeat(64),
    });
    await expect(env.DB.prepare(`UPDATE newcomer_submissions SET identity_source_record_id=?1
      WHERE id=?2`).bind(source.sourceRecordId, submissionId).run())
      .rejects.toThrow(/identity_newcomer_submission_binding_immutable/);
    expect(await env.DB.prepare(`SELECT identity_source_record_id,linked_person_id
      FROM newcomer_submissions WHERE id=?1`).bind(submissionId).first())
      .toEqual({ identity_source_record_id: null, linked_person_id: personId });
  });
});

describe('identity business Group observation adapter', () => {
  async function group() {
    return createGroup(env.DB, {
      name: `Observed Group ${next()}`,
      description: 'Gateway-only contact-bearing roster entry',
      isPublic: false,
      kind: 'fellowship',
      termLabel: null,
      termStart: null,
      termEnd: null,
    });
  }

  it('creates a safe provisional notification subject without an auth owner', async () => {
    const groupId = await group();
    const email = `group-observation-${next()}@example.test`;
    const input = {
      campusId: 1,
      operationId: crypto.randomUUID(),
      groupId,
      member: { firstName: 'Group', lastName: 'Observer', email, phone: null },
    };
    const [result, replay] = await Promise.all([
      createGroupMemberObservation(env.DB, vars, input),
      createGroupMemberObservation(env.DB, vars, input),
    ]);
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(replay).toEqual(result);
    expect(await env.DB.prepare(`SELECT count(*) n FROM group_members
      WHERE id=?1 AND group_id=?2 AND person_id=?3 AND removed_at IS NULL`)
      .bind(result.memberId, groupId, result.provisionalPersonId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM people
      WHERE id=?1 AND active=0 AND identity_state='provisional' AND auth_disabled_at IS NOT NULL`)
      .bind(result.provisionalPersonId).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM verified_contact_owners o
      JOIN contact_points cp ON cp.id=o.contact_point_id WHERE cp.normalized_value=?1`)
      .bind(email).first<number>('n')).toBe(0);
  });

  it('routes an existing verified owner to review without creating a roster member', async () => {
    const groupId = await group();
    const personId = await member();
    const email = await env.DB.prepare('SELECT email FROM people WHERE id=?1').bind(personId).first<string>('email');
    const peopleBefore = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    const result = await createGroupMemberObservation(env.DB, vars, {
      campusId: 1,
      operationId: crypto.randomUUID(),
      groupId,
      member: { firstName: 'Collision', lastName: 'Owner', email: email ?? '', phone: null },
    });
    expect(result).toEqual({ status: 'review' });
    expect(await env.DB.prepare('SELECT count(*) n FROM group_members WHERE group_id=?1 AND removed_at IS NULL')
      .bind(groupId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(peopleBefore);
  });

  it('routes an existing unverified person link to review without creating a roster member', async () => {
    const groupId = await group(); const personId = next(); const email = `group-shared-${next()}@example.test`;
    await env.DB.prepare(`INSERT INTO people(id,display_name,email,role,active,identity_state)
      VALUES(?1,'Existing Group Contact',?2,'member',1,'active')`).bind(personId, `existing-${email}`).run();
    const contact = await upsertContactPoint(env.DB, { kind: 'email', value: email });
    await ensureActivePersonContactLink(env.DB, { personId, contactPointId: contact.id, kind: 'email', source: 'test' });
    const peopleBefore = await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n');
    expect(await createGroupMemberObservation(env.DB, vars, {
      campusId: 1, operationId: crypto.randomUUID(), groupId,
      member: { firstName: 'Shared', lastName: 'Contact', email, phone: null },
    })).toEqual({ status: 'review' });
    expect(await env.DB.prepare('SELECT count(*) n FROM group_members WHERE group_id=?1 AND removed_at IS NULL')
      .bind(groupId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM people').first<number>('n')).toBe(peopleBefore);
  });
});
