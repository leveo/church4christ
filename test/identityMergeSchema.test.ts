import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_MERGE_RISK_FACT_CATEGORIES } from '../src/lib/identityMergeModel';

const hex = (c: string) => c.repeat(64);
let idSequence = 91000;
const nextId = () => ++idSequence;
const uuid = (suffix: number) => `123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`;

async function createPair() {
  const loser = nextId(); const canonical = nextId(); const caseId = nextId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
      .bind(loser, `Merge ${loser}`, `merge-${loser}@example.test`),
    env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
      .bind(canonical, `Merge ${canonical}`, `merge-${canonical}@example.test`),
    env.DB.prepare(`INSERT INTO identity_resolution_cases(
      id,campus_id,person_a_id,person_b_id,score,risk,state,version)
      VALUES(?1,1,?2,?3,90,'high','same_person',1)`).bind(caseId, loser, canonical),
  ]);
  return { loser, canonical, caseId };
}

async function insertOperation(operationId: string, pair: Awaited<ReturnType<typeof createPair>>, reverse = false) {
  const loser = reverse ? pair.canonical : pair.loser;
  const canonical = reverse ? pair.loser : pair.canonical;
  return env.DB.prepare(`INSERT INTO person_merge_operations(
    operation_id,loser_person_id,canonical_person_id,resolution_case_id,
    expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
    expected_loser_identity_version,expected_loser_session_epoch,
    expected_canonical_identity_version,expected_canonical_session_epoch,
    preview_hash,preview_version,preview_expires_at,risk,risk_state_hash,risk_state_version,
    required_approvals,state,requested_by_person_id)
    VALUES(?1,?2,?3,?4,1,?5,'campus',1,1,0,1,0,?6,1,
      '2099-01-01T00:00:00.000Z','high',?7,1,2,'previewed',?2)`)
    .bind(operationId, loser, canonical, pair.caseId, hex('c'), hex('a'), hex('b')).run();
}

async function insertFacts(operationId: string) {
  await env.DB.batch(IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category) =>
    env.DB.prepare(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES(?1,?2,?3,?4,?5,?6,?7,1)`).bind(
        operationId, category, category === 'campus_membership' ? 1 : 0,
        category === 'campus_membership' ? 1 : 0, category === 'campus_membership' ? 2 : 0,
        category === 'campus_membership' ? 1 : 0, hex('b'),
      )));
}

async function consumeMergeStepUp(operationId: string, approverPersonId: number, operationVersion = 2) {
  const challengeId = nextId();
  const value = `merge-step-up-${challengeId}@example.test`;
  const context = JSON.stringify({ person_merge_approval: {
    operation_id: operationId, operation_version: operationVersion, preview_hash: hex('a'),
    risk_state_hash: hex('b'), risk_state_version: 1, resolution_case_version: 1,
    resolution_case_hash: hex('c'), approver_person_id: approverPersonId, approver_identity_version: 1, campus_id: 1,
  } });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)").bind(challengeId, value),
    env.DB.prepare("INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source) VALUES(?1,?2,?1,'email','merge-step-up')").bind(challengeId, approverPersonId),
    env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')").bind(challengeId, approverPersonId),
    env.DB.prepare(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,request_source,person_id,contact_point_id,
      code_hash,requester_bucket_hash,expires_at,context_json,created_at,expected_session_epoch)
      VALUES(?1,?2,1,'step_up','admin',?3,?1,?4,?4,datetime('now','+5 minutes'),?5,datetime('now'),0)`)
      .bind(challengeId, uuid(nextId()), approverPersonId, hex('e'), context),
  ]);
  await env.DB.prepare("UPDATE identity_challenges SET consumed_at=datetime('now') WHERE id=?1").bind(challengeId).run();
  return challengeId;
}

describe('identity merge operations schema (D1)', () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(90991,'Approver One','approver-1@example.test','admin',1)"),
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(90992,'Approver Two','approver-2@example.test','admin',1)"),
    ]);
  });

  it('installs bounded non-PII operation evidence tables and composite rollback binding', async () => {
    const expected = [
      'person_merge_operations', 'person_merge_risk_facts', 'person_merge_approvals',
      'person_merge_risk_set_facts', 'person_merge_risk_set_seals',
      'person_merge_conflict_decisions', 'person_merge_registry_keys',
      'person_merge_mutation_receipts', 'person_merge_reassignment_journal', 'person_merge_rollback_receipts',
    ];
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'person_merge_%'")
      .all<{ name: string }>();
    for (const table of expected) expect(rows.results.map(({ name }) => name)).toContain(table);
    for (const table of expected) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(columns.results.map(({ name }) => name).filter((name) => /json|payload|note|reason|amount|answer|contact_value/i.test(name))).toEqual([]);
    }
    const rollbackFks = await env.DB.prepare('PRAGMA foreign_key_list(person_merge_rollback_receipts)')
      .all<{ table: string; from: string; to: string }>();
    expect(rollbackFks.results.filter((fk) => fk.table === 'person_merge_reassignment_journal'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ from: 'operation_id', to: 'operation_id' }),
        expect.objectContaining({ from: 'journal_id', to: 'journal_id' }),
      ]));
    const journalFks = await env.DB.prepare('PRAGMA foreign_key_list(person_merge_reassignment_journal)')
      .all<{ table: string; from: string; to: string }>();
    expect(journalFks.results.filter((fk) => fk.table === 'person_merge_mutation_receipts'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ from: 'operation_id', to: 'operation_id' }),
        expect.objectContaining({ from: 'mutation_receipt_id', to: 'mutation_receipt_id' }),
        expect.objectContaining({ from: 'reference_key', to: 'reference_key' }),
        expect.objectContaining({ from: 'row_key_hash', to: 'row_key_hash' }),
      ]));
  });

  it('serializes concurrent opposite-direction inserts and enforces CAS/immutability', async () => {
    const pair = await createPair();
    const first = uuid(nextId()); const second = uuid(nextId());
    const settled = await Promise.allSettled([
      insertOperation(first, pair), insertOperation(second, pair, true),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = (await env.DB.prepare('SELECT operation_id FROM person_merge_operations WHERE operation_id IN (?1,?2)')
      .bind(first, second).first<{ operation_id: string }>())!.operation_id;
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='cancelled' WHERE operation_id=?1")
      .bind(winner).run()).rejects.toThrow(/state_cas/);
    await expect(env.DB.prepare("UPDATE person_merge_operations SET preview_hash=?2,state='cancelled',version=2 WHERE operation_id=?1")
      .bind(winner, hex('d')).run()).rejects.toThrow(/immutable/);
  });

  it('invalidates a preview when any live risk domain drifts', async () => {
    const pair = await createPair(); const operationId = uuid(nextId());
    await insertOperation(operationId, pair); await insertFacts(operationId);
    await env.DB.prepare("INSERT INTO person_interests(person_id,category) VALUES(?1,'new-risk')").bind(pair.loser).run();
    await expect(env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(operationId).run()).rejects.toThrow(/risk_(source|set)_stale/);
  });

  it('freezes resolution-case campus and pair while enforcing exact version CAS', async () => {
    const pair = await createPair();
    await insertOperation(uuid(nextId()), pair);
    await env.DB.prepare("INSERT OR IGNORE INTO campuses(id,slug,name,active,is_default) VALUES(2,'merge-other','Merge Other',1,0)").run();
    await expect(env.DB.prepare('UPDATE identity_resolution_cases SET campus_id=2,version=2 WHERE id=?1')
      .bind(pair.caseId).run()).rejects.toThrow(/immutable/);
    await expect(env.DB.prepare("UPDATE identity_resolution_cases SET state='different_people' WHERE id=?1")
      .bind(pair.caseId).run()).rejects.toThrow(/version_cas/);
  });

  it('state-gates append-only journal and rollback evidence with static registry keys', async () => {
    const pair = await createPair(); const operationId = uuid(nextId());
    await insertOperation(operationId, pair); await insertFacts(operationId);
    const giftResultId = nextId(); const rowKeyHash = hex('e');
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO gift_results(id,person_id,top_gifts_json,recommended_json)
        VALUES(?1,?2,'[]','[]')`).bind(giftResultId, pair.loser),
      env.DB.prepare(`INSERT INTO person_merge_reference_facts(
        operation_id,reference_key,policy,side,local_row_id,row_key_hash)
        VALUES(?1,'gift_results.person_id','subject_repoint','loser',?2,?3)`)
        .bind(operationId, String(giftResultId), rowKeyHash),
    ]);
    await env.DB.prepare(`INSERT INTO person_merge_execution_seals(
      operation_id,expected_operation_version,expected_preview_hash,expected_risk_state_hash,
      expected_risk_state_version,expected_resolution_case_version,expected_resolution_case_hash,
      inventory_hash,inventory_count,expected_mutation_count,expected_irreversible_count)
      VALUES(?1,1,?2,?3,1,1,?4,?5,1,1,0)`)
      .bind(operationId, hex('a'), hex('b'), hex('c'), hex('d')).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(operationId).run();
    for (const [actor, order, approval] of [[90991, 1, uuid(nextId())], [90992, 2, uuid(nextId())]] as const) {
      const stepUpChallengeId = await consumeMergeStepUp(operationId, actor);
      await env.DB.prepare(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES(?1,?2,?3,?4,?5,'approve',2,?6,?7,1,1,?8)`)
        .bind(approval, operationId, actor, stepUpChallengeId, order, hex('a'), hex('b'), hex('c')).run();
    }
    await env.DB.prepare(`INSERT INTO person_merge_conflict_decisions(
      decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES(?1,?2,'campus_membership','dedupe',90991,2,?3,?4,1,1,?5)`)
      .bind(uuid(nextId()), operationId, hex('a'), hex('b'), hex('c')).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(operationId).run();
    await expect(env.DB.prepare(`INSERT INTO person_merge_reassignment_journal(
      journal_id,operation_id,sequence,reference_key,policy,affected_count)
      VALUES(?1,?2,1,'tokens.person_id','security_revoke',2)`).bind(uuid(nextId()), operationId).run())
      .rejects.toThrow(/journal_state/);
    await env.DB.prepare("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=?1").bind(operationId).run();
    await expect(env.DB.prepare(`INSERT INTO person_merge_reassignment_journal(
      journal_id,operation_id,sequence,reference_key,policy,affected_count)
      VALUES(?1,?2,1,'fake_table.person_id','subject_repoint',1)`).bind(uuid(nextId()), operationId).run())
      .rejects.toThrow();
    const mutationReceiptId = uuid(nextId());
    await expect(env.DB.prepare(`INSERT INTO person_merge_mutation_receipts(
      mutation_receipt_id,operation_id,execution_version,reference_key,policy,row_key_hash,
      loser_person_id,canonical_person_id,scope_kind,campus_id,affected_count)
      VALUES(?1,?2,4,'gift_results.person_id','subject_repoint',?3,?4,?5,'campus',2,1)`)
      .bind(mutationReceiptId, operationId, rowKeyHash, pair.loser, pair.canonical).run())
      .rejects.toThrow(/binding/);
    await env.DB.prepare(`INSERT INTO person_merge_mutation_receipts(
      mutation_receipt_id,operation_id,execution_version,reference_key,policy,row_key_hash,
      loser_person_id,canonical_person_id,scope_kind,campus_id,affected_count)
      VALUES(?1,?2,4,'gift_results.person_id','subject_repoint',?3,?4,?5,'campus',1,1)`)
      .bind(mutationReceiptId, operationId, rowKeyHash, pair.loser, pair.canonical).run();
    const journalId = uuid(nextId());
    await env.DB.prepare(`INSERT INTO person_merge_reassignment_journal(
      journal_id,operation_id,mutation_receipt_id,sequence,reference_key,policy,row_key_hash,affected_count)
      VALUES(?1,?2,?3,1,'gift_results.person_id','subject_repoint',?4,1)`)
      .bind(journalId, operationId, mutationReceiptId, rowKeyHash).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='failed',version=5 WHERE operation_id=?1").bind(operationId).run();
    const otherPair = await createPair(); const otherOperationId = uuid(nextId());
    await insertOperation(otherOperationId, otherPair); await insertFacts(otherOperationId);
    await env.DB.prepare("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=?1")
      .bind(otherOperationId).run();
    for (const [actor, order] of [[90991, 1], [90992, 2]] as const) {
      const stepUpChallengeId = await consumeMergeStepUp(otherOperationId, actor);
      await env.DB.prepare(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES(?1,?2,?3,?4,?5,'approve',2,?6,?7,1,1,?8)`)
        .bind(uuid(nextId()), otherOperationId, actor, stepUpChallengeId, order, hex('a'), hex('b'), hex('c')).run();
    }
    await env.DB.prepare(`INSERT INTO person_merge_conflict_decisions(
      decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES(?1,?2,'campus_membership','dedupe',90991,2,?3,?4,1,1,?5)`)
      .bind(uuid(nextId()), otherOperationId, hex('a'), hex('b'), hex('c')).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=?1").bind(otherOperationId).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=?1").bind(otherOperationId).run();
    await env.DB.prepare("UPDATE person_merge_operations SET state='failed',version=5 WHERE operation_id=?1").bind(otherOperationId).run();
    await expect(env.DB.prepare(`INSERT INTO person_merge_rollback_receipts(
      receipt_id,operation_id,journal_id,outcome,reverted_count)
      VALUES(?1,?2,?3,'reverted',1)`).bind(uuid(nextId()), otherOperationId, journalId).run())
      .rejects.toThrow(/rollback_row_drift/);
    // 0036 requires every rollback receipt to be bound to a live, approved
    // rollback operation. Legacy operation-only receipts fail closed before
    // the older standalone count contract is considered.
    await expect(env.DB.prepare(`INSERT INTO person_merge_rollback_receipts(
      receipt_id,operation_id,journal_id,outcome,reverted_count)
      VALUES(?1,?2,?3,'reverted',0)`).bind(uuid(nextId()), operationId, journalId).run())
      .rejects.toThrow(/rollback_row_drift/);
    await expect(env.DB.prepare(`INSERT INTO person_merge_rollback_receipts(
      receipt_id,operation_id,journal_id,outcome,reverted_count)
      VALUES(?1,?2,?3,'skipped',1)`).bind(uuid(nextId()), operationId, journalId).run())
      .rejects.toThrow(/rollback_state/);
    await expect(env.DB.prepare(`INSERT INTO person_merge_rollback_receipts(
      receipt_id,operation_id,journal_id,outcome,reverted_count)
      VALUES(?1,?2,?3,'failed',1)`).bind(uuid(nextId()), operationId, journalId).run())
      .rejects.toThrow(/rollback_state/);
  });

  it('rejects redirected people and redirect chains', async () => {
    const existingLoser = nextId(); const existingCanonical = nextId(); const target = nextId();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)').bind(existingLoser, 'Old loser', `old-${existingLoser}@example.test`),
      env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)').bind(existingCanonical, 'Old canonical', `old-${existingCanonical}@example.test`),
      env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)').bind(target, 'Target', `target-${target}@example.test`),
      env.DB.prepare('INSERT INTO person_merge_redirects(loser_person_id,canonical_person_id) VALUES(?1,?2)').bind(existingLoser, existingCanonical),
    ]);
    for (const [loser, canonical, expected] of [
      [existingLoser, target, /redirect/], [existingCanonical, target, /redirect_chain/],
    ] as const) {
      const caseId = nextId();
      await env.DB.prepare(`INSERT INTO identity_resolution_cases(
        id,campus_id,person_a_id,person_b_id,score,risk,state,version)
        VALUES(?1,1,?2,?3,90,'high','same_person',1)`).bind(caseId, loser, canonical).run();
      await expect(insertOperation(uuid(nextId()), { loser, canonical, caseId })).rejects.toThrow(expected);
    }
    await expect(env.DB.prepare('UPDATE person_merge_redirects SET canonical_person_id=?1 WHERE loser_person_id=?2')
      .bind(target, existingLoser).run()).rejects.toThrow(/append_only/);
    await expect(env.DB.prepare('DELETE FROM person_merge_redirects WHERE loser_person_id=?1')
      .bind(existingLoser).run()).rejects.toThrow(/append_only/);
  });
});
