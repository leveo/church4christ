import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { beginRecovery, completeRecoveryRequest } from '../src/lib/identityAccount';
import { identityTrustedRequestContext } from '../src/lib/identityAuth';
import { ensureActivePersonContactLink, upsertContactPoint } from '../src/lib/identityDb';
import { loadSessionUser } from '../src/lib/currentUser';
import { mintSession, verifySession } from '../src/lib/session';
import {
  approveIdentityRecovery,
  getIdentityRecoveryCase,
  getIdentityRecoveryTargetSummary,
  peekIdentityRecoveryVeto,
  vetoIdentityRecovery,
} from '../src/lib/identityRecovery';
import { deliverIdentityRecoveryNotifications, enqueueIdentityRecoveryNotification } from '../src/lib/identityRecoveryOutbox';

const authEnv = {
  IDENTITY_VERIFICATION_SECRET: 'identity-recovery-test-secret-at-least-thirty-two-characters',
  IDENTITY_RECOVERY_KEY_SECRET: 'identity-recovery-stable-key-secret-at-least-thirty-two-characters',
  IDENTITY_RECOVERY_KEY_ID: 'v1',
};
const requestNow = '2035-01-01 00:00:00';
let sequence = 870_000;

const context = () => identityTrustedRequestContext(
  new Headers({ 'CF-Connecting-IP': `203.0.113.${++sequence % 240 + 1}` }),
  `identity-recovery-${sequence}`,
);

function assurance(at: number) {
  return { schemaVersion: 2 as const, sessionId: crypto.randomUUID(), authMethod: 'email_otp' as const, authTime: at, stepUpTime: at };
}

async function makePerson(label: string, options: { superAdmin?: boolean; role?: 'member' | 'admin' } = {}) {
  const id = ++sequence;
  const email = `${label.toLowerCase().replaceAll(' ', '-')}-${id}@example.test`;
  const role = options.role ?? (options.superAdmin ? 'admin' : 'member');
  await env.DB.prepare(`INSERT INTO people(id,display_name,email,role,super_admin,active,identity_state)
    VALUES(?1,?2,?3,?4,?5,1,'active')`).bind(id, label, email, role, options.superAdmin ? 1 : 0).run();
  return { id, email };
}

async function ownEmail(personId: number, email: string) {
  const point = await upsertContactPoint(env.DB, { kind: 'email', value: email });
  await ensureActivePersonContactLink(env.DB, { personId, contactPointId: point.id, kind: 'email', source: 'test' });
  await env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')")
    .bind(point.id, personId).run();
  return point;
}

async function openCase(target: { id: number; email: string }, reachableEmail = `reachable-${++sequence}@example.test`) {
  const begun = await beginRecovery(env.DB, authEnv, {
    campusId: 1,
    accountEmail: target.email,
    reachableEmail,
    requestContext: context(),
    now: requestNow,
  });
  const completed = await completeRecoveryRequest(env.DB, authEnv, {
    campusId: 1,
    operationId: begun.public.operationId,
    publicId: begun.delivery.publicId,
    code: begun.delivery.code,
    now: '2035-01-01 00:01:00',
  });
  if (completed.status !== 'review') throw new Error('test recovery case was not created');
  return { id: completed.recoveryCaseId, reachableEmail, operationId: begun.public.operationId };
}

describe('high-risk identity recovery', () => {
  let target: { id: number; email: string };
  let firstAdmin: { id: number; email: string };
  let secondAdmin: { id: number; email: string };

  beforeEach(async () => {
    target = await makePerson('Recovery Target');
    firstAdmin = await makePerson('First Recovery Admin', { superAdmin: true });
    secondAdmin = await makePerson('Second Recovery Admin', { superAdmin: true });
    await ownEmail(target.id, target.email);
  });

  it('binds a PII-safe target hint and keeps known/unknown requests neutral', async () => {
    const known = await openCase(target);
    const unknownPerson = { id: 0, email: `unknown-${++sequence}@example.test` };
    const unknown = await openCase(unknownPerson);
    const knownRow = await getIdentityRecoveryCase(env.DB, 1, known.id);
    const unknownRow = await getIdentityRecoveryCase(env.DB, 1, unknown.id);
    expect(knownRow?.personId).toBe(target.id);
    expect(unknownRow?.personId).toBeNull();
    expect(knownRow?.claimedTargetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(unknownRow?.claimedTargetHash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify([knownRow, unknownRow]);
    expect(serialized).not.toContain(target.email);
    expect(serialized).not.toContain(unknownPerson.email);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_recovery_notification_outbox
      WHERE case_id=?1 AND category='request_old_contact'`).bind(known.id).first<number>('n')).toBe(1);
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_recovery_notification_outbox
      WHERE case_id=?1 AND category='request_old_contact'`).bind(unknown.id).first<number>('n')).toBe(0);
  });

  it('keeps pending veto mail and delivered veto links valid when only the OTP verification secret rotates', async () => {
    const recovery = await openCase(target);
    const initialSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliverIdentityRecoveryNotifications(env.DB, { ...authEnv, EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' },
      { caseId: recovery.id, now: '2035-01-01 00:01:30' });
    initialSpy.mockRestore();
    const epoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    const first = await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id,
      actorPersonId: firstAdmin.id, assurance: assurance(epoch), now: '2035-01-01 00:02:00' });
    if (first.status !== 'holding') throw new Error('hold not created');
    const rotatedOtpEnv = { ...authEnv, IDENTITY_VERIFICATION_SECRET: 'rotated-otp-secret-that-is-still-at-least-thirty-two-characters' };
    await expect(peekIdentityRecoveryVeto(env.DB, rotatedOtpEnv, first.vetoToken, '2035-01-01 00:03:00'))
      .resolves.toEqual({ valid: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(deliverIdentityRecoveryNotifications(env.DB, { ...rotatedOtpEnv, EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' },
      { caseId: recovery.id, now: '2035-01-01 00:03:00' })).resolves.toMatchObject({ sent: 1 });
    expect(spy.mock.calls.flat().join('\n')).toContain(first.vetoToken);
    spy.mockRestore();
  });

  it('fails closed before claiming pending mail when the stable recovery key differs from its database pin', async () => {
    const recovery = await openCase(target);
    const pending = await env.DB.prepare(`SELECT id,state FROM identity_recovery_notification_outbox
      WHERE case_id=?1 AND category='request_old_contact'`).bind(recovery.id).first<{ id: number; state: string }>();
    expect(pending?.state).toBe('pending');
    const misconfigured = { ...authEnv, IDENTITY_RECOVERY_KEY_SECRET: 'different-stable-recovery-key-secret-at-least-thirty-two-characters',
      IDENTITY_RECOVERY_KEY_ID: 'v2', EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };
    await expect(deliverIdentityRecoveryNotifications(env.DB, misconfigured, { caseId: recovery.id, now: '2035-01-01 00:02:00' }))
      .rejects.toThrow(/identity_recovery_key_configuration_mismatch/);
    expect(await env.DB.prepare('SELECT state,attempt_count FROM identity_recovery_notification_outbox WHERE id=?1')
      .bind(pending!.id).first()).toEqual({ state: 'pending', attempt_count: 0 });
  });

  it('requires recent step-up and two different active super admins', async () => {
    const recovery = await openCase(target);
    const epoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    await expect(approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id, assurance: assurance(epoch - 601), now: '2035-01-01 00:02:00',
    })).resolves.toEqual({ status: 'step_up_required' });
    const first = await approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id, assurance: assurance(epoch), now: '2035-01-01 00:02:00',
    });
    expect(first.status).toBe('holding');
    const nextEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    await expect(approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id, assurance: assurance(nextEpoch), now: '2035-01-02 00:02:00',
    })).resolves.toEqual({ status: 'blocked', reason: 'different_approver_required' });
    await expect(approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id, assurance: assurance(epoch), now: '2035-01-02 00:02:00',
    })).resolves.toEqual({ status: 'step_up_required' });
  });

  it('rejects a forged first approval after the reachable contact link changed', async () => {
    const recovery = await openCase(target);
    const intruder = await makePerson('Pre-hold Link Intruder');
    const reachablePointId = await env.DB.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?1")
      .bind(recovery.reachableEmail).first<number>('id');
    await env.DB.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source)
      VALUES(?1,?2,'email','race')`).bind(intruder.id, reachablePointId).run();
    await expect(env.DB.prepare(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,
        expected_case_version,expected_person_id,expected_person_identity_version,expected_person_session_epoch,
        expected_reachable_owner_person_id,expected_reachable_owner_generation,created_at)
      VALUES(?1,?2,'first_approval',?3,1,?4,1,0,NULL,0,'2035-01-01 00:02:00')`)
      .bind(crypto.randomUUID(), recovery.id, firstAdmin.id, target.id).run())
      .rejects.toThrow(/identity_recovery_first_guard/);
  });

  it('enforces the cooling boundary, supports scanner-safe veto, and makes veto permanent', async () => {
    const recovery = await openCase(target);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    const first = await approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00',
    });
    if (first.status !== 'holding') throw new Error('hold not created');
    expect(await peekIdentityRecoveryVeto(env.DB, authEnv, first.vetoToken, '2035-01-01 00:03:00')).toEqual({ valid: true });
    expect(await env.DB.prepare("SELECT count(*) n FROM identity_recovery_decisions WHERE case_id=?1 AND decision='veto'").bind(recovery.id).first<number>('n')).toBe(0);
    expect(await vetoIdentityRecovery(env.DB, authEnv, first.vetoToken, '2035-01-01 00:03:00')).toEqual({ vetoed: true });
    expect(await vetoIdentityRecovery(env.DB, authEnv, first.vetoToken, '2035-01-01 00:04:00')).toEqual({ vetoed: true });
    const secondEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    expect(await approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id, assurance: assurance(secondEpoch), now: '2035-01-02 00:02:00',
    })).toEqual({ status: 'blocked', reason: 'vetoed' });
  });

  it('serializes a veto racing the second approval so recovery and veto cannot both commit', async () => {
    const recovery = await openCase(target);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    const first = await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id,
      actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' });
    if (first.status !== 'holding') throw new Error('hold not created');
    const secondEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    await Promise.all([
      vetoIdentityRecovery(env.DB, authEnv, first.vetoToken, '2035-01-02 00:02:00'),
      approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id,
        assurance: assurance(secondEpoch), now: '2035-01-02 00:02:00' }),
    ]);
    const decisions = await env.DB.prepare("SELECT decision FROM identity_recovery_decisions WHERE case_id=?1 AND decision IN ('veto','executed') ORDER BY decision")
      .bind(recovery.id).all<{ decision: string }>();
    expect(decisions.results).toHaveLength(1);
  });

  it('blocks one second before 24 hours and succeeds exactly at the boundary', async () => {
    const recovery = await openCase(target);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    await approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00',
    });
    const earlyEpoch = Math.floor(Date.parse('2035-01-02T00:01:59Z') / 1000);
    expect(await approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id, assurance: assurance(earlyEpoch), now: '2035-01-02 00:01:59',
    })).toEqual({ status: 'blocked', reason: 'cooling_period' });
    const boundaryEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    expect(await approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id, assurance: assurance(boundaryEpoch), now: '2035-01-02 00:02:00',
    })).toMatchObject({ status: 'completed', personId: target.id, sessionEpoch: 1 });
  });

  it('allows one deliberate unresolved target bind before review and freezes every identity/source binding afterward', async () => {
    const unknown = await openCase({ id: 0, email: `unresolved-${++sequence}@example.test` });
    const before = await getIdentityRecoveryCase(env.DB, 1, unknown.id);
    expect(before?.personId).toBeNull();
    await expect(env.DB.prepare(`UPDATE identity_recovery_cases SET person_id=?1,version=version+1
      WHERE id=?2 AND person_id IS NULL AND version=?3`).bind(target.id, unknown.id, before!.version).run()).resolves.toMatchObject({ success: true });
    await expect(env.DB.prepare('UPDATE identity_recovery_cases SET person_id=?1 WHERE id=?2')
      .bind(firstAdmin.id, unknown.id).run()).rejects.toThrow(/identity_recovery_binding_immutable/);

    const bound = await getIdentityRecoveryCase(env.DB, 1, unknown.id);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    const first = await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: unknown.id,
      actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' });
    expect(first.status).toBe('holding');

    const drifts = [
      env.DB.prepare('UPDATE identity_recovery_cases SET campus_id=2 WHERE id=?1').bind(unknown.id),
      env.DB.prepare('UPDATE identity_recovery_cases SET person_id=?1 WHERE id=?2').bind(secondAdmin.id, unknown.id),
      env.DB.prepare(`UPDATE identity_recovery_cases SET contact_point_id=(SELECT contact_point_id FROM verified_contact_owners WHERE person_id=?1 LIMIT 1)
        WHERE id=?2`).bind(target.id, unknown.id),
      env.DB.prepare('UPDATE identity_recovery_cases SET source_operation_id=NULL WHERE id=?1').bind(unknown.id),
      env.DB.prepare("UPDATE identity_recovery_cases SET claimed_target_hash=?1 WHERE id=?2").bind('d'.repeat(64), unknown.id),
      env.DB.prepare('UPDATE identity_recovery_cases SET source_version=source_version+1 WHERE id=?1').bind(unknown.id),
    ];
    for (const drift of drifts) await expect(drift.run()).rejects.toThrow(/identity_recovery_binding_immutable/);
    await expect(env.DB.prepare('UPDATE identity_recovery_owner_snapshots SET expected_generation=expected_generation+1 WHERE case_id=?1')
      .bind(unknown.id).run()).rejects.toThrow(/identity_recovery_owner_snapshots_append_only/);
    expect(await getIdentityRecoveryCase(env.DB, 1, unknown.id)).toMatchObject({
      campusId: bound!.campusId,
      personId: bound!.personId,
      contactPointId: bound!.contactPointId,
      sourceOperationId: bound!.sourceOperationId,
      claimedTargetHash: bound!.claimedTargetHash,
      sourceVersion: bound!.sourceVersion,
    });
  });

  it('enforces case, hold, and veto expiry boundaries', async () => {
    const expiredCase = await openCase(target);
    await env.DB.prepare("UPDATE identity_recovery_cases SET expires_at='2035-01-01 00:02:00' WHERE id=?1").bind(expiredCase.id).run();
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    expect(await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: expiredCase.id,
      actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' }))
      .toEqual({ status: 'blocked', reason: 'expired' });

    const atBoundary = await openCase(target);
    const first = await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: atBoundary.id,
      actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' });
    if (first.status !== 'holding') throw new Error('hold not created');
    expect(await peekIdentityRecoveryVeto(env.DB, authEnv, first.vetoToken, '2035-01-08 00:00:59')).toEqual({ valid: true });
    expect(await vetoIdentityRecovery(env.DB, authEnv, first.vetoToken, '2035-01-08 00:00:59')).toEqual({ vetoed: true });

    const afterBoundary = await openCase(target);
    const secondHold = await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: afterBoundary.id,
      actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' });
    if (secondHold.status !== 'holding') throw new Error('hold not created');
    expect(await peekIdentityRecoveryVeto(env.DB, authEnv, secondHold.vetoToken, '2035-01-08 00:01:00')).toEqual({ valid: false });
    expect(await vetoIdentityRecovery(env.DB, authEnv, secondHold.vetoToken, '2035-01-08 00:01:00')).toEqual({ vetoed: false });
    const lateEpoch = Math.floor(Date.parse('2035-01-08T00:01:00Z') / 1000);
    expect(await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: afterBoundary.id,
      actorPersonId: secondAdmin.id, assurance: assurance(lateEpoch), now: '2035-01-08 00:01:00' }))
      .toEqual({ status: 'blocked', reason: 'expired' });
  });

  it('rejects a reachable mailbox shared by any active household link and serializes the link/hold race', async () => {
    const linked = await openCase(target);
    const linkedCase = await getIdentityRecoveryCase(env.DB, 1, linked.id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO households(id,name) VALUES(?1,'Recovery Shared Household')").bind(++sequence),
      env.DB.prepare(`INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source)
        VALUES(1,?1,?2,'test')`).bind(sequence, linkedCase!.contactPointId),
    ]);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    expect(await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: linked.id,
      actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' }))
      .toEqual({ status: 'blocked', reason: 'contact_conflict' });

    const raced = await openCase(target);
    const racedCase = await getIdentityRecoveryCase(env.DB, 1, raced.id);
    const householdId = ++sequence;
    await env.DB.prepare("INSERT INTO households(id,name) VALUES(?1,'Racing Household')").bind(householdId).run();
    const [approval, household] = await Promise.allSettled([
      approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: raced.id,
        actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' }),
      env.DB.prepare(`INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source)
        VALUES(1,?1,?2,'test')`).bind(householdId, racedCase!.contactPointId).run(),
    ]);
    const holdCount = await env.DB.prepare('SELECT count(*) n FROM identity_recovery_holds WHERE case_id=?1').bind(raced.id).first<number>('n');
    const householdCount = await env.DB.prepare('SELECT count(*) n FROM household_contact_links WHERE contact_point_id=?1 AND ended_at IS NULL')
      .bind(racedCase!.contactPointId).first<number>('n');
    expect((holdCount ?? 0) + (householdCount ?? 0)).toBe(1);
    if (holdCount === 1) {
      expect(approval).toMatchObject({ status: 'fulfilled', value: { status: 'holding' } });
      expect(household.status).toBe('rejected');
    }
  });

  it('revokes every auth-owner kind but sends recovery notices only to verified email contacts', async () => {
    const phone = await upsertContactPoint(env.DB, { kind: 'phone', value: '+1 415 555 0199' });
    await ensureActivePersonContactLink(env.DB, { personId: target.id, contactPointId: phone.id, kind: 'phone', source: 'test' });
    await env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')")
      .bind(phone.id, target.id).run();
    const recovery = await openCase(target);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    const first = await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id,
      actorPersonId: firstAdmin.id, assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' });
    if (first.status !== 'holding') throw new Error('hold not created');
    expect(first.notifyOldContacts).toEqual([target.email]);
    const secondEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    const completed = await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id,
      actorPersonId: secondAdmin.id, assurance: assurance(secondEpoch), now: '2035-01-02 00:02:00' });
    expect(completed).toMatchObject({ status: 'completed', notifyOldContacts: [target.email] });
    expect(await env.DB.prepare('SELECT person_id FROM verified_contact_owners WHERE contact_point_id=?1').bind(phone.id).first<number>('person_id')).toBeNull();
  });

  it('uses a retryable leased outbox and acknowledges only a successful recovery notification send', async () => {
    const recovery = await openCase(target);
    expect(await enqueueIdentityRecoveryNotification(env.DB, authEnv, {
      caseId: recovery.id, category: 'request_old_contact', recipient: target.email, locale: 'en',
    })).toBe(false);
    expect(await enqueueIdentityRecoveryNotification(env.DB, authEnv, {
      caseId: recovery.id, category: 'request_old_contact', recipient: target.email.toUpperCase(), locale: 'en',
    })).toBe(false);
    expect(await env.DB.prepare('SELECT case_id,state,category,contact_point_id FROM identity_recovery_notification_outbox WHERE case_id=?1')
      .bind(recovery.id).first()).toMatchObject({ case_id: recovery.id, state: 'pending', category: 'request_old_contact' });
    expect(await env.DB.prepare(`SELECT count(*) n FROM identity_recovery_notification_outbox o JOIN contact_points cp
      ON cp.id=o.contact_point_id AND cp.kind='email' WHERE (?1 IS NULL OR o.case_id=?1)
      AND (o.state IN ('pending','failed') OR (o.state='claimed' AND o.lease_expires_at<=?2))`)
      .bind(recovery.id, '2035-01-01 00:02:00').first<number>('n')).toBe(1);
    const failedSend = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    expect(await deliverIdentityRecoveryNotifications(env.DB, {
      ...authEnv, EMAIL_FROM: 'security@example.test', EMAIL: { send: failedSend }, APP_ORIGIN: 'https://church.example',
    } as never, { caseId: recovery.id, now: '2035-01-01 00:02:00' })).toEqual({ attempted: 1, sent: 0, failed: 1 });
    expect(await env.DB.prepare('SELECT state,attempt_count FROM identity_recovery_notification_outbox WHERE case_id=?1')
      .bind(recovery.id).first()).toEqual({ state: 'failed', attempt_count: 1 });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await deliverIdentityRecoveryNotifications(env.DB, {
      ...authEnv, EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example',
    }, { caseId: recovery.id, now: '2035-01-01 00:03:00' })).toEqual({ attempted: 1, sent: 1, failed: 0 });
    spy.mockRestore();
    expect(await env.DB.prepare('SELECT state,attempt_count,lease_token_hash,lease_expires_at FROM identity_recovery_notification_outbox WHERE case_id=?1')
      .bind(recovery.id).first()).toEqual({ state: 'sent', attempt_count: 2, lease_token_hash: null, lease_expires_at: null });
    const receipts = await env.DB.prepare('SELECT event,attempt FROM identity_recovery_notification_receipts WHERE outbox_id=(SELECT id FROM identity_recovery_notification_outbox WHERE case_id=?1) ORDER BY id')
      .bind(recovery.id).all<{ event: string; attempt: number }>();
    expect(receipts.results).toEqual([
      { event: 'pending', attempt: 0 }, { event: 'claimed', attempt: 1 }, { event: 'failed', attempt: 1 },
      { event: 'claimed', attempt: 2 }, { event: 'sent', attempt: 2 },
    ]);
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM identity_recovery_notification_receipts').all())).not.toContain(target.email);
  });

  it('recovers an expired notification lease and prevents concurrent duplicate sends', async () => {
    const recovery = await openCase(target);
    const initialSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliverIdentityRecoveryNotifications(env.DB, { ...authEnv, EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' },
      { caseId: recovery.id, now: '2035-01-01 00:01:30' });
    initialSpy.mockRestore();
    await enqueueIdentityRecoveryNotification(env.DB, authEnv, {
      caseId: recovery.id, category: 'completed_old_contact', recipient: target.email, locale: 'zh',
    });
    const leaseExpires = new Date(Date.now() - 1000);
    const formatLease = (value: Date) => value.toISOString().slice(0, 19).replace('T', ' ');
    await env.DB.prepare(`UPDATE identity_recovery_notification_outbox SET state='claimed',attempt_count=1,
      lease_token_hash=?1,lease_expires_at=?2 WHERE case_id=?3 AND category='completed_old_contact'`)
      .bind('a'.repeat(64), formatLease(leaseExpires), recovery.id).run();
    const deliveryEnv = { ...authEnv, EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' };
    expect(await deliverIdentityRecoveryNotifications(env.DB, deliveryEnv, { caseId: recovery.id, now: formatLease(new Date(leaseExpires.getTime() - 1000)) }))
      .toEqual({ attempted: 0, sent: 0, failed: 0 });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const results = await Promise.all([
      deliverIdentityRecoveryNotifications(env.DB, deliveryEnv, { caseId: recovery.id, now: formatLease(leaseExpires) }),
      deliverIdentityRecoveryNotifications(env.DB, deliveryEnv, { caseId: recovery.id, now: formatLease(leaseExpires) }),
    ]);
    spy.mockRestore();
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
    expect(await env.DB.prepare("SELECT count(*) n FROM email_log WHERE kind='identityRecoveryCompleted'").first<number>('n')).toBe(1);
  });

  it('persists the critical veto payload encrypted so a failed hold email remains retryable', async () => {
    const recovery = await openCase(target);
    const initialSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await deliverIdentityRecoveryNotifications(env.DB, { ...authEnv, EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' },
      { caseId: recovery.id, now: '2035-01-01 00:01:30' });
    initialSpy.mockRestore();
    const vetoToken = 'v'.repeat(43);
    await enqueueIdentityRecoveryNotification(env.DB, authEnv, {
      caseId: recovery.id, category: 'hold_old_contact', recipient: target.email, locale: 'en', vetoToken,
    });
    const stored = await env.DB.prepare('SELECT payload_ciphertext,state FROM identity_recovery_notification_outbox WHERE case_id=?1')
      .bind(recovery.id).first<{ payload_ciphertext: string; state: string }>();
    expect(stored?.payload_ciphertext).not.toContain(vetoToken);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect((await deliverIdentityRecoveryNotifications(env.DB, { ...authEnv, EMAIL_DEV_LOG: '1', APP_ORIGIN: 'https://church.example' },
      { caseId: recovery.id, now: '2035-01-01 00:02:00' })).sent).toBe(1);
    expect(spy.mock.calls.flat().join('\n')).toContain(vetoToken);
    spy.mockRestore();
  });

  it('returns only a server-resolved, PII-minimized target review summary', async () => {
    await env.DB.prepare("UPDATE people SET role='admin',super_admin=1,finance=1,admin_areas='people' WHERE id=?1").bind(target.id).run();
    const recovery = await openCase(target);
    expect(await getIdentityRecoveryTargetSummary(env.DB, 1, recovery.id)).toEqual({
      displayName: 'Recovery Target',
      verifiedContactCategories: [{ kind: 'email', count: 1 }],
      activeCampusCount: 1,
      riskCategories: ['super_admin', 'finance', 'scoped_admin'],
    });
  });

  it('atomically replaces authentication ownership while preserving every privilege and business relationship', async () => {
    await env.DB.prepare("UPDATE people SET role='admin',super_admin=1,finance=1,admin_areas='people,giving' WHERE id=?1").bind(target.id).run();
    await env.DB.prepare('UPDATE person_contact_links SET is_primary=1 WHERE person_id=?1 AND ended_at IS NULL').bind(target.id).run();
    await env.DB.prepare("UPDATE campus_memberships SET role='editor',finance=1,admin_areas='people' WHERE campus_id=1 AND person_id=?1").bind(target.id).run();
    const before = await env.DB.prepare('SELECT role,super_admin,finance,admin_areas FROM people WHERE id=?1').bind(target.id)
      .first<{ role: string; super_admin: number; finance: number; admin_areas: string }>();
    const campusBefore = await env.DB.prepare('SELECT role,finance,admin_areas,active FROM campus_memberships WHERE campus_id=1 AND person_id=?1')
      .bind(target.id).first();
    const oldJwt = await mintSession('identity-recovery-session-secret-at-least-thirty-two-characters', { id: target.id, sessionEpoch: 0 }, { authMethod: 'email_otp' });
    const recovery = await openCase(target);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    const secondEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id,
      assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' });
    const results = await Promise.all(Array.from({ length: 4 }, () => approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id, assurance: assurance(secondEpoch), now: '2035-01-02 00:02:00',
    })));
    expect(results.filter((result) => result.status === 'completed')).toHaveLength(1);
    expect(await env.DB.prepare(`SELECT category FROM identity_recovery_notification_outbox WHERE case_id=?1 ORDER BY category`)
      .bind(recovery.id).all<{ category: string }>()).toMatchObject({ results: [
        { category: 'completed_old_contact' }, { category: 'hold_old_contact' }, { category: 'request_old_contact' },
      ] });
    expect(await env.DB.prepare('SELECT person_id FROM verified_contact_owners o JOIN contact_points c ON c.id=o.contact_point_id WHERE c.normalized_value=?1')
      .bind(recovery.reachableEmail).first<number>('person_id')).toBe(target.id);
    expect(await env.DB.prepare('SELECT person_id FROM verified_contact_owners o JOIN contact_points c ON c.id=o.contact_point_id WHERE c.normalized_value=?1')
      .bind(target.email).first<number>('person_id')).toBeNull();
    expect(await env.DB.prepare('SELECT is_primary,notification_enabled FROM person_contact_links l JOIN contact_points c ON c.id=l.contact_point_id WHERE l.person_id=?1 AND c.normalized_value=?2 AND l.ended_at IS NULL')
      .bind(target.id, target.email).first()).toEqual({ is_primary: 0, notification_enabled: 1 });
    expect(await env.DB.prepare('SELECT role,super_admin,finance,admin_areas FROM people WHERE id=?1').bind(target.id).first()).toEqual(before);
    expect(await env.DB.prepare('SELECT role,finance,admin_areas,active FROM campus_memberships WHERE campus_id=1 AND person_id=?1').bind(target.id).first()).toEqual(campusBefore);
    expect(await env.DB.prepare('SELECT session_epoch FROM people WHERE id=?1').bind(target.id).first<number>('session_epoch')).toBe(1);
    const oldClaims = await verifySession('identity-recovery-session-secret-at-least-thirty-two-characters', oldJwt);
    expect(oldClaims?.epoch).toBe(0);
    expect(await loadSessionUser(env.DB, target.id, oldClaims!.epoch)).toBeNull();
  });

  it('blocks an NFC recovery contact that canonically matches another Unicode legacy person', async () => {
    const legacy = await makePerson('Unicode Legacy Collision');
    const legacyNfd = `legacy-e\u0301-${legacy.id}@example.test`;
    const reachableNfc = legacyNfd.normalize('NFC');
    await env.DB.prepare('UPDATE people SET email=?1 WHERE id=?2').bind(legacyNfd, legacy.id).run();

    const recovery = await openCase(target, reachableNfc);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    const secondEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    await expect(approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id,
      assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00',
    })).resolves.toMatchObject({ status: 'holding' });
    await expect(approveIdentityRecovery(env.DB, authEnv, {
      campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id,
      assurance: assurance(secondEpoch), now: '2035-01-02 00:02:00',
    })).resolves.toEqual({ status: 'blocked', reason: 'contact_conflict' });

    await expect(env.DB.prepare(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,
        expected_case_version,expected_person_id,expected_person_identity_version,expected_person_session_epoch,
        expected_reachable_owner_generation,created_at)
      VALUES(?1,?2,'second_approval',?3,2,?4,1,0,0,'2035-01-02 00:02:00')`)
      .bind(crypto.randomUUID(), recovery.id, secondAdmin.id, target.id).run())
      .rejects.toThrow(/identity_recovery_second_guard/);
    expect(await env.DB.prepare(`SELECT person_id FROM verified_contact_owners owner JOIN contact_points contact
      ON contact.id=owner.contact_point_id WHERE contact.kind='email' AND contact.normalized_value=?1`)
      .bind(reachableNfc).first<number>('person_id')).toBeNull();
  });

  it.each(['case_version', 'person_version', 'owner_generation', 'merged_target', 'reachable_conflict'] as const)('blocks stale or ambiguous execution: %s', async (drift) => {
    const recovery = await openCase(target);
    const firstEpoch = Math.floor(Date.parse('2035-01-01T00:02:00Z') / 1000);
    await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id, actorPersonId: firstAdmin.id,
      assurance: assurance(firstEpoch), now: '2035-01-01 00:02:00' });
    if (drift === 'case_version') await env.DB.prepare('UPDATE identity_recovery_cases SET version=version+1 WHERE id=?1').bind(recovery.id).run();
    if (drift === 'person_version') await env.DB.prepare('UPDATE people SET identity_version=identity_version+1 WHERE id=?1').bind(target.id).run();
    if (drift === 'owner_generation') {
      const point = await env.DB.prepare("SELECT contact_point_id FROM verified_contact_owners WHERE person_id=?1").bind(target.id).first<number>('contact_point_id');
      await env.DB.batch([
        env.DB.prepare("INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation) VALUES(?1,1,?2,NULL,'revoke')").bind(point, target.id),
        env.DB.prepare('DELETE FROM verified_contact_owners WHERE contact_point_id=?1').bind(point),
      ]);
    }
    if (drift === 'merged_target') await env.DB.prepare("UPDATE people SET identity_state='merged',auth_disabled_at=datetime('now') WHERE id=?1").bind(target.id).run();
    if (drift === 'reachable_conflict') {
      const intruder = await makePerson('Reachable Intruder');
      const reachablePointId = await env.DB.prepare("SELECT id FROM contact_points WHERE kind='email' AND normalized_value=?1")
        .bind(recovery.reachableEmail).first<number>('id');
      await env.DB.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,ended_at)
        VALUES(?1,?2,'email','test','2034-12-31 00:00:00')`).bind(intruder.id, reachablePointId).run();
      await expect(env.DB.prepare(`UPDATE person_contact_links SET ended_at=NULL
        WHERE person_id=?1 AND contact_point_id=?2`).bind(intruder.id, reachablePointId).run())
        .rejects.toThrow(/identity_recovery_reachable_person_link_conflict/);
      return;
    }
    const secondEpoch = Math.floor(Date.parse('2035-01-02T00:02:00Z') / 1000);
    expect((await approveIdentityRecovery(env.DB, authEnv, { campusId: 1, caseId: recovery.id, actorPersonId: secondAdmin.id,
      assurance: assurance(secondEpoch), now: '2035-01-02 00:02:00' })).status).toBe('blocked');
  });

  it('keeps recovery audit metadata free of raw PII', async () => {
    const recovery = await openCase(target);
    const rows = await env.DB.prepare("SELECT metadata_json FROM identity_audit_events WHERE event_type LIKE 'identity_recovery_%'").all<{ metadata_json: string }>();
    expect(JSON.stringify(rows.results)).not.toContain(target.email);
    expect(JSON.stringify(rows.results)).not.toContain(recovery.reachableEmail);
  });
});
