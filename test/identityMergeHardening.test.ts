import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  attachIdentitySourceForSignedInSession,
  identityGatewaySessionContext,
  registerIdentitySource,
} from '../src/lib/identityGateway';
import { IDENTITY_MERGE_RISK_FACT_CATEGORIES } from '../src/lib/identityMergeModel';

const hash = (char: string) => char.repeat(64);
let sequence = 89400;
const next = () => ++sequence;
const sourceEnv = {
  IDENTITY_SOURCE_KEY_SECRET: 'merge-risk-set-source-key-secret-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
};

async function pair(options: { caseState?: 'open' | 'same_person'; privileged?: 'loser' | 'both' } = {}) {
  const first = next(); const second = next(); const caseId = next();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people(id,display_name,email,role,super_admin,finance)
      VALUES(?1,?2,?3,?4,?5,?6)`).bind(first, `Pair ${first}`, `pair-${first}@example.test`,
      options.privileged ? 'admin' : 'member', options.privileged ? 1 : 0, options.privileged ? 1 : 0),
    env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)")
      .bind(second, `Pair ${second}`, `pair-${second}@example.test`),
    env.DB.prepare(`INSERT INTO identity_resolution_cases(id,campus_id,person_a_id,person_b_id,score,risk,state,version)
      VALUES(?1,1,?2,?3,90,'high',?4,1)`).bind(caseId, first, second, options.caseState ?? 'same_person'),
  ]);
  if (options.privileged === 'both') {
    await env.DB.prepare("UPDATE people SET role='admin',super_admin=1,finance=1 WHERE id=?1").bind(second).run();
  }
  return { first, second, caseId };
}

async function operation(input: {
  pair: Awaited<ReturnType<typeof pair>>;
  operationId: string;
  risk?: 'normal' | 'high' | 'critical';
  approvals?: 1 | 2;
  expiresAt?: string;
}) {
  const risk = input.risk ?? 'high';
  const approvals = input.approvals ?? (risk === 'normal' ? 1 : 2);
  await env.DB.prepare(`INSERT INTO person_merge_operations(
    operation_id,loser_person_id,canonical_person_id,resolution_case_id,
    expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
    expected_loser_identity_version,expected_loser_session_epoch,
    expected_canonical_identity_version,expected_canonical_session_epoch,
    preview_hash,preview_version,preview_expires_at,risk,risk_state_hash,risk_state_version,
    required_approvals,state,requested_by_person_id)
    VALUES(?1,?2,?3,?4,1,?5,'campus',1,1,0,1,0,?6,1,?7,?8,?9,1,?10,'previewed',?11)`)
    .bind(input.operationId, input.pair.first, input.pair.second, input.pair.caseId,
      hash('c'), hash('a'), input.expiresAt ?? '2099-01-01T00:00:00.000Z', risk, hash('b'), approvals,
      input.pair.first).run();
}

async function facts(operationId: string, overrides: Partial<Record<string, [number, number, number]>> = {}) {
  await env.DB.batch(IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category) => {
    const [loser, canonical, collision] = overrides[category] ?? (category === 'campus_membership' ? [1, 1, 1] : [0, 0, 0]);
    return env.DB.prepare(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES(?1,?2,?3,?4,?5,?6,?7,1)`).bind(operationId, category, loser, canonical, loser + canonical, collision, hash('b'));
  }));
}

async function decision(operationId: string, actor: number, category: string, value: string, suffix: number) {
  return env.DB.prepare(`INSERT INTO person_merge_conflict_decisions(
    decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
    expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
    expected_resolution_case_version,expected_resolution_case_hash)
    VALUES(?1,?2,?3,?4,?5,2,?6,?7,1,1,?8)`)
    .bind(`123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`, operationId, category, value, actor,
      hash('a'), hash('b'), hash('c')).run();
}

async function consumeMergeStepUp(operationId: string, approverPersonId: number, operationVersion = 2) {
  const challengeId = next();
  const value = `hardening-step-up-${challengeId}@example.test`;
  const context = JSON.stringify({ person_merge_approval: {
    operation_id: operationId, operation_version: operationVersion, preview_hash: hash('a'),
    risk_state_hash: hash('b'), risk_state_version: 1, resolution_case_version: 1,
    resolution_case_hash: hash('c'), approver_person_id: approverPersonId, approver_identity_version: 1, campus_id: 1,
  } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)").bind(challengeId, value),
    env.DB.prepare("INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source) VALUES(?1,?2,?1,'email','merge-step-up')").bind(challengeId, approverPersonId),
    env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(challengeId, approverPersonId),
    env.DB.prepare(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,request_source,person_id,contact_point_id,
      code_hash,requester_bucket_hash,expires_at,context_json,created_at,expected_session_epoch)
      VALUES(?1,?2,1,'step_up','admin',?3,?1,?4,?4,datetime('now','+5 minutes'),?5,datetime('now'),0)`)
      .bind(challengeId, `123e4567-e89b-42d3-a456-${String(next()).padStart(12, '0')}`, approverPersonId, hash('e'), context),
  ]);
  await env.DB.prepare("UPDATE identity_challenges SET consumed_at=datetime('now') WHERE id=?1").bind(challengeId).run();
  return challengeId;
}

describe('identity merge hardening invariants (D1)', () => {
  it('requires a confirmed same-person case and binds its version and hash', async () => {
    const open = await pair({ caseState: 'open' });
    await expect(operation({ pair: open, operationId: '123e4567-e89b-42d3-a456-426614179201' }))
      .rejects.toThrow(/case_binding/);
    const confirmed = await pair();
    await operation({ pair: confirmed, operationId: '123e4567-e89b-42d3-a456-426614179202' });
    await expect(env.DB.prepare(`UPDATE identity_resolution_cases SET version=2 WHERE id=?1`).bind(confirmed.caseId).run()).resolves.toBeTruthy();
    await facts('123e4567-e89b-42d3-a456-426614179202');
    await expect(env.DB.prepare(`UPDATE person_merge_operations SET state='awaiting_approval',version=2
      WHERE operation_id='123e4567-e89b-42d3-a456-426614179202'`).run()).rejects.toThrow(/case_stale/);
  });

  it('requires the complete deterministic risk fact vocabulary before approval', async () => {
    expect(IDENTITY_MERGE_RISK_FACT_CATEGORIES).toEqual(expect.arrayContaining([
      'privilege', 'verified_contact_owner', 'household', 'stripe_customer', 'stripe_recurring',
      'external_identity', 'learning_identity', 'active_credential', 'person_interest', 'event_admin',
    ]));
    const target = await pair();
    const id = '123e4567-e89b-42d3-a456-426614179203';
    await operation({ pair: target, operationId: id });
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/risk_facts/);
    await facts(id);
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run();
  });

  it('binds every decision and approval to preview, risk state, and case state', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179204';
    await operation({ pair: target, operationId: id }); await facts(id);
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();
    await expect(env.DB.prepare(`INSERT INTO person_merge_conflict_decisions(
      decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179211',?1,'privilege','keep_both',?2,2,?3,?4,1,1,?5)`)
      .bind(id, target.first, hash('a'), hash('b'), hash('c')).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO person_merge_conflict_decisions(
      decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179212',?1,'privilege','canonical_only',?2,2,?3,?4,1,1,?5)`)
      .bind(id, target.first, hash('d'), hash('b'), hash('c')).run()).rejects.toThrow(/decision_stale/);
  });

  it('requires distinct consumed merge-bound step-up evidence and revalidates revocation live', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179209';
    const firstAdmin = next(); const secondAdmin = next();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Step-up Admin A',?2,'admin',1)")
        .bind(firstAdmin, `step-up-a-${firstAdmin}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Step-up Admin B',?2,'admin',1)")
        .bind(secondAdmin, `step-up-b-${secondAdmin}@example.test`),
    ]);
    await operation({ pair: target, operationId: id }); await facts(id);
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();
    await expect(env.DB.prepare(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179225',?1,?2,1,'approve',2,?3,?4,1,1,?5)`)
      .bind(id, firstAdmin, hash('a'), hash('b'), hash('c')).run()).rejects.toThrow(/step_up|NOT NULL/);
    const firstStepUp = await consumeMergeStepUp(id, firstAdmin);
    await expect(env.DB.prepare("UPDATE identity_challenges SET context_json='{}' WHERE id=?1").bind(firstStepUp).run())
      .rejects.toThrow(/binding_immutable/);
    await env.DB.prepare(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179226',?1,?2,?3,1,'approve',2,?4,?5,1,1,?6)`)
      .bind(id, firstAdmin, firstStepUp, hash('a'), hash('b'), hash('c')).run();
    const secondStepUp = await consumeMergeStepUp(id, secondAdmin);
    await env.DB.prepare(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179227',?1,?2,?3,2,'approve',2,?4,?5,1,1,?6)`)
      .bind(id, secondAdmin, secondStepUp, hash('a'), hash('b'), hash('c')).run();
    await decision(id, firstAdmin, 'campus_membership', 'dedupe', 179228);
    await env.DB.prepare("UPDATE identity_challenges SET superseded_at=datetime('now') WHERE id=?1").bind(firstStepUp).run();
    await expect(env.DB.prepare("UPDATE identity_challenges SET superseded_at=NULL WHERE id=?1").bind(firstStepUp).run())
      .rejects.toThrow(/binding_immutable/);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(id).run())
      .rejects.toThrow(/approval_eligibility/);
  });

  it('treats any reject as a terminal veto even when approval count is otherwise satisfied', async () => {
    const target = await pair({ privileged: 'both' }); const id = '123e4567-e89b-42d3-a456-426614179205';
    const rejectingAdmin = next(); const approvingAdmin = next();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Rejecting Admin',?2,'admin',1)")
        .bind(rejectingAdmin, `rejecting-${rejectingAdmin}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Approving Admin',?2,'admin',1)")
        .bind(approvingAdmin, `approving-${approvingAdmin}@example.test`),
    ]);
    await operation({ pair: target, operationId: id, risk: 'critical' }); await facts(id, { privilege: [1, 1, 0] });
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();
    await decision(id, target.first, 'privilege', 'canonical_only', 179220);
    await decision(id, target.first, 'campus_membership', 'dedupe', 179219);
    const rejectStepUp = await consumeMergeStepUp(id, rejectingAdmin);
    await env.DB.prepare(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179221',?1,?2,?3,1,'reject',2,?4,?5,1,1,?6)`)
      .bind(id, rejectingAdmin, rejectStepUp, hash('a'), hash('b'), hash('c')).run();
    const approveStepUp = await consumeMergeStepUp(id, approvingAdmin);
    await env.DB.prepare(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179222',?1,?2,?3,2,'approve',2,?4,?5,1,1,?6)`)
      .bind(id, approvingAdmin, approveStepUp, hash('a'), hash('b'), hash('c')).run();
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/veto/);
  });

  it('also vetoes execution when a reject arrives after approval', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179208';
    const approverOne = next(); const approverTwo = next();
    await env.DB.batch([
      env.DB.prepare("UPDATE campus_memberships SET active=0 WHERE person_id IN (?1,?2)").bind(target.first, target.second),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,?2,?3,'admin',1)")
        .bind(approverOne, 'Late veto approver', `late-veto-${approverOne}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,?2,?3,'admin',1)")
        .bind(approverTwo, 'Late veto reviewer', `late-veto-${approverTwo}@example.test`),
    ]);
    await operation({ pair: target, operationId: id, risk: 'normal', approvals: 1 }); await facts(id, { campus_membership: [0, 0, 0] });
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();
    const insertApproval = async (approvalId: string, actor: number, order: number, approvalDecision: 'approve' | 'reject', version: number) => {
      const stepUpChallengeId = await consumeMergeStepUp(id, actor, version);
      return env.DB.prepare(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,1,?10)`)
        .bind(approvalId, id, actor, stepUpChallengeId, order, approvalDecision, version, hash('a'), hash('b'), hash('c')).run();
    };
    await insertApproval('123e4567-e89b-42d3-a456-426614179223', approverOne, 1, 'approve', 2);
    await env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(id).run();
    await insertApproval('123e4567-e89b-42d3-a456-426614179224', approverTwo, 2, 'reject', 3);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/veto/);
  });

  it('rejects non-canonical ISO expiry and fake journal registry keys', async () => {
    const bad = await pair();
    await expect(operation({ pair: bad, operationId: '123e4567-e89b-42d3-a456-426614179206', expiresAt: '2099-01-01 00:00:00' }))
      .rejects.toThrow();
    const impossible = await pair();
    await expect(operation({ pair: impossible, operationId: '123e4567-e89b-42d3-a456-426614179207', expiresAt: '2099-02-30T00:00:00.000Z' }))
      .rejects.toThrow();
    const keys = await env.DB.prepare('SELECT reference_key FROM person_merge_registry_keys ORDER BY reference_key').all<{ reference_key: string }>();
    expect(keys.results).toEqual(expect.arrayContaining([{ reference_key: 'tokens.person_id' }]));
    await expect(env.DB.prepare("INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES('fake_table.person_id','subject_repoint')").run())
      .rejects.toThrow(/append_only/);
    await expect(env.DB.prepare(`INSERT INTO person_merge_reassignment_journal(
      journal_id,operation_id,sequence,reference_key,policy,affected_count)
      VALUES('123e4567-e89b-42d3-a456-426614179231','missing-operation',1,'fake_table.person_id','subject_repoint',1)`).run())
      .rejects.toThrow();
  });

  it('invalidates directional privilege movement even when aggregate counts stay equal', async () => {
    const target = await pair({ privileged: 'loser' }); const id = '123e4567-e89b-42d3-a456-426614179240';
    await operation({ pair: target, operationId: id, risk: 'critical' });
    await facts(id, { privilege: [1, 0, 0] });
    await env.DB.batch([
      env.DB.prepare("UPDATE people SET role='member',super_admin=0,finance=0,admin_areas='' WHERE id=?1").bind(target.first),
      env.DB.prepare("UPDATE people SET role='admin',super_admin=1,finance=1,admin_areas='people' WHERE id=?1").bind(target.second),
    ]);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/risk_(source|set)_stale/);
  });

  it('invalidates same-side privilege composition changes when counts stay equal', async () => {
    const target = await pair({ privileged: 'loser' }); const id = '123e4567-e89b-42d3-a456-426614179254';
    await operation({ pair: target, operationId: id, risk: 'critical' });
    await facts(id, { privilege: [1, 0, 0] });
    await env.DB.prepare("UPDATE people SET role='member',super_admin=0,finance=1,admin_areas='' WHERE id=?1")
      .bind(target.first).run();
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/risk_set_stale/);
  });

  it('invalidates campus A-to-B substitution when membership counts stay equal', async () => {
    const target = await pair(); const campusId = next();
    const id = '123e4567-e89b-42d3-a456-426614179255';
    await env.DB.prepare("INSERT INTO campuses(id,slug,name) VALUES(?1,?2,'Replacement Campus')")
      .bind(campusId, `replacement-${campusId}`).run();
    await operation({ pair: target, operationId: id });
    await facts(id);
    await env.DB.batch([
      env.DB.prepare('UPDATE campus_memberships SET active=0 WHERE campus_id=1 AND person_id=?1').bind(target.first),
      env.DB.prepare(`INSERT INTO campus_memberships(campus_id,person_id,role,finance,admin_areas,active)
        VALUES(?1,?2,'member',0,'',1)`).bind(campusId, target.first),
    ]);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/risk_set_stale/);
  });

  it('invalidates group and team role replacement when membership counts stay equal', async () => {
    const target = await pair(); const ministryId = next(); const teamId = next(); const groupId = next();
    const memberId = next(); const id = '123e4567-e89b-42d3-a456-426614179256';
    await env.DB.batch([
      env.DB.prepare("INSERT INTO ministries(id,slug,category) VALUES(?1,?2,'service')")
        .bind(ministryId, `merge-${ministryId}`),
      env.DB.prepare('INSERT INTO teams(id,ministry_id) VALUES(?1,?2)').bind(teamId, ministryId),
      env.DB.prepare("INSERT INTO groups(id,name,description,is_public) VALUES(?1,'Merge Group','',0)").bind(groupId),
      env.DB.prepare(`INSERT INTO group_members(id,group_id,person_id,display_name,is_admin)
        VALUES(?1,?2,?3,'Merge Member',0)`).bind(memberId, groupId, target.first),
      env.DB.prepare('INSERT INTO team_members(team_id,person_id,is_leader) VALUES(?1,?2,0)').bind(teamId, target.first),
    ]);
    await operation({ pair: target, operationId: id });
    await facts(id, { group_membership: [1, 0, 0], team_membership: [1, 0, 0] });
    await env.DB.batch([
      env.DB.prepare('UPDATE group_members SET is_admin=1 WHERE id=?1').bind(memberId),
      env.DB.prepare('UPDATE team_members SET is_leader=1 WHERE team_id=?1 AND person_id=?2').bind(teamId, target.first),
    ]);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/risk_set_stale/);
  });

  it('invalidates contact and credential identity replacement at constant counts', async () => {
    const target = await pair(); const oldContact = next(); const newContact = next();
    const oldLink = next(); const newLink = next(); const oldToken = next(); const newToken = next();
    const id = '123e4567-e89b-42d3-a456-426614179257';
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO contact_points(id,kind,normalized_value,display_value)
        VALUES(?1,'email',?2,?2)`).bind(oldContact, `merge-old-${oldContact}@example.test`),
      env.DB.prepare(`INSERT INTO contact_points(id,kind,normalized_value,display_value)
        VALUES(?1,'email',?2,?2)`).bind(newContact, `merge-new-${newContact}@example.test`),
      env.DB.prepare(`INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source)
        VALUES(?1,?2,?3,'email','test')`).bind(oldLink, target.first, oldContact),
      env.DB.prepare(`INSERT INTO tokens(id,token_hash,person_id,purpose,expires_at)
        VALUES(?1,?2,?3,'respond','2099-01-01T00:00:00.000Z')`).bind(oldToken, hash('1') + oldToken, target.first),
    ]);
    await operation({ pair: target, operationId: id });
    await facts(id, { contact_link: [1, 0, 0], active_credential: [1, 0, 0] });
    await env.DB.batch([
      env.DB.prepare("UPDATE person_contact_links SET ended_at=datetime('now') WHERE id=?1").bind(oldLink),
      env.DB.prepare(`INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source)
        VALUES(?1,?2,?3,'email','test')`).bind(newLink, target.first, newContact),
      env.DB.prepare("UPDATE tokens SET used_at=datetime('now') WHERE id=?1").bind(oldToken),
      env.DB.prepare(`INSERT INTO tokens(id,token_hash,person_id,purpose,expires_at)
        VALUES(?1,?2,?3,'respond','2099-01-01T00:00:00.000Z')`).bind(newToken, hash('2') + newToken, target.first),
    ]);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/risk_set_stale/);
  });

  it.each([
    {
      label: 'Stripe customer',
      category: 'stripe_customer',
      setup: async (personId: number) => {
        await env.DB.prepare("UPDATE people SET stripe_customer_id='cus_merge_original' WHERE id=?1").bind(personId).run();
      },
      mutate: async (personId: number) => {
        await expect(env.DB.prepare(`UPDATE people SET stripe_customer_id='cus_merge_bypass',
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version+1 WHERE id=?1`).bind(personId).run())
          .rejects.toThrow(/semantic_binding_version_invalid/);
        await expect(env.DB.prepare(`UPDATE people SET
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version+2 WHERE id=?1`).bind(personId).run())
          .rejects.toThrow(/semantic_binding_version_invalid/);
        await env.DB.prepare(`UPDATE people SET
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version+1 WHERE id=?1`).bind(personId).run();
        await expect(env.DB.prepare(`UPDATE people SET
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version-1 WHERE id=?1`).bind(personId).run())
          .rejects.toThrow(/semantic_binding_version_invalid/);
        await env.DB.prepare("UPDATE people SET stripe_customer_id='cus_merge_replacement' WHERE id=?1").bind(personId).run();
      },
    },
    {
      label: 'calendar bearer',
      category: 'active_credential',
      setup: async (personId: number) => {
        await env.DB.prepare("UPDATE people SET calendar_token='calendar-merge-original' WHERE id=?1").bind(personId).run();
      },
      mutate: async (personId: number) => {
        await env.DB.prepare("UPDATE people SET calendar_token='calendar-merge-replacement' WHERE id=?1").bind(personId).run();
      },
    },
    {
      label: 'external provider identity',
      category: 'external_identity',
      setup: async (personId: number) => {
        const identityId = next();
        await env.DB.prepare(`INSERT INTO person_external_identities(
          id,person_id,provider,organization_id,external_person_id)
          VALUES(?1,?2,'planning_center','100','200')`).bind(identityId, personId).run();
        return identityId;
      },
      mutate: async (_personId: number, identityId?: number) => {
        await env.DB.prepare(`UPDATE person_external_identities
          SET organization_id='101',external_person_id='201' WHERE id=?1`).bind(identityId).run();
      },
    },
    {
      label: 'learning provider identity',
      category: 'learning_identity',
      setup: async (personId: number) => {
        const connectionId = next(); const identityId = next();
        await env.DB.prepare(`INSERT INTO learning_provider_connections(id,provider,display_name,status)
          VALUES(?1,'google_classroom',?2,'active')`).bind(connectionId, `Merge Learning ${connectionId}`).run();
        await env.DB.prepare(`INSERT INTO learning_identity_links(
          id,connection_id,person_id,external_user_id,status)
          VALUES(?1,?2,?3,'learning-original','active')`).bind(identityId, connectionId, personId).run();
        return identityId;
      },
      mutate: async (_personId: number, identityId?: number) => {
        await env.DB.prepare("UPDATE learning_identity_links SET external_user_id='learning-replacement' WHERE id=?1")
          .bind(identityId).run();
      },
    },
    {
      label: 'canonical identity key',
      category: 'canonical_key',
      setup: async (personId: number) => {
        await env.DB.prepare(`UPDATE identity_person_canonical_keys
          SET legacy_email_key='canonical-original',normalized_name_key='canonical-original-name',
            normalization_version=1,is_current=1 WHERE person_id=?1`).bind(personId).run();
      },
      mutate: async (personId: number) => {
        await env.DB.prepare(`UPDATE identity_person_canonical_keys
          SET legacy_email_key='canonical-replacement',normalized_name_key='canonical-replacement-name'
          WHERE person_id=?1`).bind(personId).run();
      },
    },
  ])('invalidates a same-row $label substitution without exposing its value', async ({ category, setup, mutate }) => {
    const target = await pair();
    const operationId = `123e4567-e89b-42d3-a456-${String(next()).padStart(12, '0')}`;
    const sourceId = await setup(target.first);
    await operation({ pair: target, operationId });
    await facts(operationId, { [category]: [1, 0, 0] });
    const snapshot = await env.DB.prepare(`SELECT item_key FROM person_merge_risk_set_facts
      WHERE operation_id=?1 AND category=?2`).bind(operationId, category).all<{ item_key: string }>();
    expect(snapshot.results).toHaveLength(1);
    expect(snapshot.results[0].item_key).not.toMatch(/cus_merge|calendar-merge|planning_center|:100|:200|learning-original|canonical-original/);
    await mutate(target.first, sourceId);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(operationId).run()).rejects.toThrow(/risk_set_stale/);
  });

  it('freezes source ownership and all preview-bound set facts after snapshot', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179258';
    await operation({ pair: target, operationId: id });
    await expect(env.DB.prepare(`INSERT INTO person_merge_risk_set_facts(operation_id,category,side,item_key)
      VALUES(?1,'source_record','loser','record:fake:owner:linked')`).bind(id).run())
      .rejects.toThrow(/risk_set_facts_sealed/);
    await expect(env.DB.prepare('DELETE FROM person_merge_risk_set_facts WHERE operation_id=?1').bind(id).run())
      .rejects.toThrow(/risk_set_facts_append_only/);
    const columns = await env.DB.prepare('PRAGMA table_info(person_merge_risk_set_facts)').all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual(['operation_id', 'category', 'side', 'item_key']);
    expect(columns.results.map(({ name }) => name).join(' ')).not.toMatch(/email|phone|token|amount|note|answer|payload/i);
  });

  it('blocks constant-count source ownership replacement at its writer boundary', async () => {
    const target = await pair(); const sourceKey = `merge-source-${next()}`;
    const source = await registerIdentitySource(env.DB, sourceEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: sourceKey,
      email: `merge-source-${next()}@example.test`, attachmentPolicy: 'signed_in_or_claim', sourceDigest: hash('8'),
    });
    await attachIdentitySourceForSignedInSession(env.DB, sourceEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
      expectedVersion: 1, sourceDigest: hash('8'),
      session: identityGatewaySessionContext({ personId: target.first, campusId: 1, sessionEpoch: 0 }),
    });
    const id = '123e4567-e89b-42d3-a456-426614179259';
    await operation({ pair: target, operationId: id });
    await facts(id, { source_record: [1, 0, 0] });
    await expect(env.DB.prepare(`UPDATE identity_source_records SET linked_person_id=?1
      WHERE id=?2`).bind(target.second, source.sourceRecordId).run())
      .rejects.toThrow(/identity_source_attachment_immutable/);
    const snapshot = await env.DB.prepare(`SELECT item_key FROM person_merge_risk_set_facts
      WHERE operation_id=?1 AND category='source_record'`).bind(id).all<{ item_key: string }>();
    expect(snapshot.results).toEqual([{ item_key: `record:${source.sourceRecordId}:campus:1:source:giving:state:linked:owner:linked` }]);
    expect(snapshot.results[0].item_key).not.toContain(sourceKey);
  });

  it('counts calendar bearer credentials and requires two eligible super-admin approvals', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179241';
    await env.DB.batch([
      env.DB.prepare("UPDATE campus_memberships SET active=0 WHERE person_id IN (?1,?2)").bind(target.first, target.second),
      env.DB.prepare("UPDATE people SET calendar_token='calendar-secret' WHERE id=?1").bind(target.first),
    ]);
    await operation({ pair: target, operationId: id, risk: 'normal', approvals: 1 });
    await facts(id, { campus_membership: [0, 0, 0] });
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(id).run()).rejects.toThrow(/risk_source_stale|risk_facts_stale/);
  });

  it('requires every mapped conflict decision before approval', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179242';
    const firstApprover = next(); const secondApprover = next();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Decision A',?2,'admin',1)")
        .bind(firstApprover, `decision-${firstApprover}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Decision B',?2,'admin',1)")
        .bind(secondApprover, `decision-${secondApprover}@example.test`),
    ]);
    await operation({ pair: target, operationId: id }); await facts(id);
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();
    for (const [actor, order, suffix] of [[firstApprover, 1, 179243], [secondApprover, 2, 179244]] as const) {
      const stepUpChallengeId = await consumeMergeStepUp(id, actor);
      await env.DB.prepare(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES(?1,?2,?3,?4,?5,'approve',2,?6,?7,1,1,?8)`)
        .bind(`123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`, id, actor, stepUpChallengeId, order, hash('a'), hash('b'), hash('c')).run();
    }
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(id).run())
      .rejects.toThrow(/decisions_missing/);
    await decision(id, firstApprover, 'campus_membership', 'dedupe', 179245);
    await env.DB.prepare('UPDATE people SET active=0 WHERE id=?1').bind(firstApprover).run();
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(id).run())
      .rejects.toThrow(/approval_eligibility/);
    await env.DB.prepare('UPDATE people SET active=1 WHERE id=?1').bind(firstApprover).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(id).run();
    await env.DB.prepare('UPDATE people SET auth_disabled_at=datetime(\'now\') WHERE id=?1').bind(secondApprover).run();
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=?1").bind(id).run())
      .rejects.toThrow(/approval_eligibility/);
  });

  it('rejects member-role and auth-disabled super-admin flag rows as high-risk approvers', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179246';
    const memberFlag = next(); const disabledAdmin = next();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,super_admin) VALUES(?1,'Member Flag',?2,1)")
        .bind(memberFlag, `member-flag-${memberFlag}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Disabled Admin',?2,'admin',1)")
        .bind(disabledAdmin, `disabled-${disabledAdmin}@example.test`),
    ]);
    await operation({ pair: target, operationId: id }); await facts(id);
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();
    const memberStepUp = await consumeMergeStepUp(id, memberFlag);
    const disabledStepUp = await consumeMergeStepUp(id, disabledAdmin);
    await env.DB.prepare("UPDATE people SET auth_disabled_at=datetime('now') WHERE id=?1").bind(disabledAdmin).run();
    for (const [actor, stepUpChallengeId, order, suffix] of [
      [memberFlag, memberStepUp, 1, 179247], [disabledAdmin, disabledStepUp, 2, 179248],
    ] as const) {
      await expect(env.DB.prepare(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES(?1,?2,?3,?4,?5,'approve',2,?6,?7,1,1,?8)`)
        .bind(`123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`, id, actor, stepUpChallengeId, order, hash('a'), hash('b'), hash('c')).run())
        .rejects.toThrow(/requires_master_admin|step_up_invalid/);
    }
  });

  it('requires a currently eligible campus administrator even for normal-risk approval', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179252'; const member = next();
    await env.DB.batch([
      env.DB.prepare('UPDATE campus_memberships SET active=0 WHERE person_id IN (?1,?2)').bind(target.first, target.second),
      env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(?1,'Normal Member Approver',?2)")
        .bind(member, `normal-member-${member}@example.test`),
    ]);
    await operation({ pair: target, operationId: id, risk: 'normal', approvals: 1 });
    await facts(id, { campus_membership: [0, 0, 0] });
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();
    const stepUpChallengeId = await consumeMergeStepUp(id, member);
    await expect(env.DB.prepare(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179253',?1,?2,?3,1,'approve',2,?4,?5,1,1,?6)`)
      .bind(id, member, stepUpChallengeId, hash('a'), hash('b'), hash('c')).run()).rejects.toThrow(/requires_master_admin|step_up_invalid/);
  });

  it('rejects campus-member approval bindings and revalidates campus admin role at approval and execution', async () => {
    const target = await pair(); const id = '123e4567-e89b-42d3-a456-426614179260';
    const firstAdmin = next(); const secondAdmin = next(); const demotedMember = next();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Campus Admin A',?2,'admin',1)")
        .bind(firstAdmin, `campus-admin-a-${firstAdmin}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Campus Admin B',?2,'admin',1)")
        .bind(secondAdmin, `campus-admin-b-${secondAdmin}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Campus Member',?2,'admin',1)")
        .bind(demotedMember, `campus-member-${demotedMember}@example.test`),
      env.DB.prepare("UPDATE campus_memberships SET role='member' WHERE person_id=?1 AND campus_id=1").bind(demotedMember),
    ]);
    await operation({ pair: target, operationId: id }); await facts(id);
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1").bind(id).run();

    const memberStepUp = await consumeMergeStepUp(id, demotedMember);
    await expect(env.DB.prepare(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179261',?1,?2,?3,1,'approve',2,?4,?5,1,1,?6)`)
      .bind(id, demotedMember, memberStepUp, hash('a'), hash('b'), hash('c')).run())
      .rejects.toThrow(/requires_master_admin|step_up_invalid/);

    for (const [approver, order, suffix] of [
      [firstAdmin, 1, 179262], [secondAdmin, 2, 179263],
    ] as const) {
      const stepUp = await consumeMergeStepUp(id, approver);
      await env.DB.prepare(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES(?1,?2,?3,?4,?5,'approve',2,?6,?7,1,1,?8)`)
        .bind(`123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`, id, approver, stepUp, order,
          hash('a'), hash('b'), hash('c')).run();
    }
    await decision(id, firstAdmin, 'campus_membership', 'dedupe', 179264);

    await env.DB.prepare("UPDATE campus_memberships SET role='member' WHERE person_id=?1 AND campus_id=1").bind(firstAdmin).run();
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(id).run())
      .rejects.toThrow(/approval_eligibility/);
    await env.DB.prepare("UPDATE campus_memberships SET role='admin' WHERE person_id=?1 AND campus_id=1").bind(firstAdmin).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(id).run();
    await env.DB.prepare("UPDATE campus_memberships SET role='member' WHERE person_id=?1 AND campus_id=1").bind(secondAdmin).run();
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=?1").bind(id).run())
      .rejects.toThrow(/approval_eligibility/);
  });

  it('requires an exact eligible master administrator for global merge requests', async () => {
    const target = await pair(); const memberFlag = next(); const disabledAdmin = next(); const validAdmin = next();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,super_admin) VALUES(?1,'Global Member Flag',?2,1)")
        .bind(memberFlag, `global-member-${memberFlag}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin,auth_disabled_at) VALUES(?1,'Global Disabled',?2,'admin',1,datetime('now'))")
        .bind(disabledAdmin, `global-disabled-${disabledAdmin}@example.test`),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,'Global Admin',?2,'admin',1)")
        .bind(validAdmin, `global-admin-${validAdmin}@example.test`),
    ]);
    const insert = (operationId: string, requester: number) => env.DB.prepare(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,
      expected_canonical_identity_version,expected_canonical_session_epoch,
      preview_hash,preview_version,preview_expires_at,risk,risk_state_hash,risk_state_version,
      required_approvals,state,requested_by_person_id)
      VALUES(?1,?2,?3,?4,1,?5,'global',NULL,1,0,1,0,?6,1,'2099-01-01T00:00:00.000Z',
        'normal',?7,1,1,'previewed',?8)`)
      .bind(operationId, target.first, target.second, target.caseId, hash('c'), hash('a'), hash('b'), requester).run();
    await expect(insert('123e4567-e89b-42d3-a456-426614179249', memberFlag)).rejects.toThrow(/requires_master_admin/);
    await expect(insert('123e4567-e89b-42d3-a456-426614179250', disabledAdmin)).rejects.toThrow(/requires_master_admin/);
    await expect(insert('123e4567-e89b-42d3-a456-426614179251', validAdmin)).resolves.toBeTruthy();
  });
});
