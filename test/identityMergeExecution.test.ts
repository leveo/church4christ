import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  beginIdentityMergeApproval,
  completeIdentityMergeApproval,
  completeIdentityMergeRollbackApproval,
  createIdentityMergeOperation,
  createIdentityMergeRollback,
  beginIdentityMergeRollbackApproval,
  executeIdentityMerge,
  executeIdentityMergeRollback,
  previewIdentityMerge,
  recordIdentityMergeDecision,
  submitIdentityMergeForApproval,
  IDENTITY_MERGE_EXECUTION_COVERAGE_KEYS,
} from '../src/lib/identityMergeExecution';
import { identityTrustedRequestContext } from '../src/lib/identityAuth';
import {
  attachIdentitySourceForSignedInSession,
  identityGatewaySessionContext,
  registerIdentitySource,
} from '../src/lib/identityGateway';
import {
  IDENTITY_MERGE_REFERENCE_REGISTRY,
  IDENTITY_MERGE_TEXT_ACTOR_REGISTRY,
  mergeReferenceKey,
} from '../src/lib/identityMergeRegistry';

let personSequence = 960_000;
const nextPersonId = () => ++personSequence;

async function createConfirmedPair() {
  const loserPersonId = nextPersonId();
  const canonicalPersonId = nextPersonId();
  const requesterPersonId = nextPersonId();
  const caseId = nextPersonId();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
      .bind(loserPersonId, `Execution loser ${loserPersonId}`, `execution-loser-${loserPersonId}@example.test`),
    env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
      .bind(canonicalPersonId, `Execution canonical ${canonicalPersonId}`, `execution-canonical-${canonicalPersonId}@example.test`),
    env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,?2,?3,'admin',1)")
      .bind(requesterPersonId, `Execution requester ${requesterPersonId}`, `execution-requester-${requesterPersonId}@example.test`),
  ]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM campus_memberships WHERE person_id=?1').bind(loserPersonId),
    env.DB.prepare('DELETE FROM campus_memberships WHERE person_id=?1').bind(canonicalPersonId),
    env.DB.prepare(`INSERT INTO identity_resolution_cases(
      id,campus_id,person_a_id,person_b_id,score,risk,state,version)
      VALUES(?1,1,?2,?3,99,'normal','same_person',1)`)
      .bind(caseId, loserPersonId, canonicalPersonId),
  ]);
  return { loserPersonId, canonicalPersonId, requesterPersonId, caseId };
}

describe('identity merge execution foundation (D1)', () => {
  it('exposes the typed backend merge lifecycle', async () => {
    await expect(import('../src/lib/identityMergeExecution')).resolves.toEqual(expect.objectContaining({
      previewIdentityMerge: expect.any(Function),
      createIdentityMergeOperation: expect.any(Function),
      recordIdentityMergeDecision: expect.any(Function),
      submitIdentityMergeForApproval: expect.any(Function),
      beginIdentityMergeApproval: expect.any(Function),
      completeIdentityMergeApproval: expect.any(Function),
      executeIdentityMerge: expect.any(Function),
      createIdentityMergeRollback: expect.any(Function),
      beginIdentityMergeRollbackApproval: expect.any(Function),
      completeIdentityMergeRollbackApproval: expect.any(Function),
      executeIdentityMergeRollback: expect.any(Function),
    }));
  });

  it('maps every closed non-historical registry reference to a handler or explicit blocker', () => {
    const coverage = new Set(IDENTITY_MERGE_EXECUTION_COVERAGE_KEYS);
    const missing = [...IDENTITY_MERGE_REFERENCE_REGISTRY, ...IDENTITY_MERGE_TEXT_ACTOR_REGISTRY]
      .filter(({ policy }) => policy !== 'historical_preserve')
      .map(({ table, column }) => mergeReferenceKey(table, column))
      .filter((key) => !coverage.has(key));
    expect(missing).toEqual([]);
  });

  it('installs sealed non-PII execution and rollback evidence', async () => {
    const expected = [
      'person_merge_execution_seals',
      'person_merge_reference_facts',
      'person_merge_journal_row_details',
      'person_merge_rollback_operations',
      'person_merge_rollback_approvals',
    ];
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'person_merge_%'",
    ).all<{ name: string }>();
    const names = rows.results.map(({ name }) => name);
    for (const table of expected) expect(names).toContain(table);
    for (const table of expected) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(columns.results.map(({ name }) => name).filter((name) =>
        /json|payload|note|reason|amount|answer|contact_value|external_id|provider_id/i.test(name),
      )).toEqual([]);
    }
  });

  it('binds new redirects to an exact merge operation', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(person_merge_redirects)')
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toContain('merge_operation_id');
    const index = await env.DB.prepare('PRAGMA index_list(person_merge_redirects)')
      .all<{ name: string; unique: number }>();
    expect(index.results).toContainEqual(expect.objectContaining({
      name: 'idx_person_merge_redirects_operation',
      unique: 1,
    }));
  });

  it('previews and atomically creates only a confirmed same_person operation with a sealed inventory', async () => {
    const pair = await createConfirmedPair();
    const input = {
      backend: 'd1' as const,
      caseId: pair.caseId,
      loserPersonId: pair.loserPersonId,
      canonicalPersonId: pair.canonicalPersonId,
      requestedByPersonId: pair.requesterPersonId,
      scope: { kind: 'global' as const },
      now: new Date().toISOString(),
    };
    const preview = await previewIdentityMerge(env.DB, input);
    expect(preview).toEqual(expect.objectContaining({
      risk: 'normal',
      requiredApprovals: 1,
      blockers: [],
      inventoryCount: expect.any(Number),
      inventoryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      previewHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    const created = await createIdentityMergeOperation(env.DB, input);
    expect(created).toEqual(expect.objectContaining({ status: 'created', version: 1 }));
    const row = await env.DB.prepare(`SELECT op.state,op.risk,op.required_approvals,seal.inventory_hash,seal.inventory_count
      FROM person_merge_operations op JOIN person_merge_execution_seals seal ON seal.operation_id=op.operation_id
      WHERE op.operation_id=?1`).bind(created.operationId).first<{
        state: string; risk: string; required_approvals: number; inventory_hash: string; inventory_count: number;
      }>();
    expect(row).toEqual(expect.objectContaining({
      state: 'previewed', risk: 'normal', required_approvals: 1,
      inventory_hash: created.preview.inventoryHash,
      inventory_count: created.preview.inventoryCount,
    }));
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM person_merge_risk_facts WHERE operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(17);
  });

  it('fails closed before create when the loser has verified contact ownership', async () => {
    const pair = await createConfirmedPair();
    const contactId = nextPersonId();
    const email = `execution-owned-${contactId}@example.test`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)")
        .bind(contactId, email),
      env.DB.prepare("INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source) VALUES(?1,?2,?1,'email','execution-test')")
        .bind(contactId, pair.loserPersonId),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')")
        .bind(contactId, pair.loserPersonId),
    ]);
    const input = {
      backend: 'd1' as const,
      caseId: pair.caseId,
      loserPersonId: pair.loserPersonId,
      canonicalPersonId: pair.canonicalPersonId,
      requestedByPersonId: pair.requesterPersonId,
      scope: { kind: 'global' as const },
      now: new Date().toISOString(),
    };
    const preview = await previewIdentityMerge(env.DB, input);
    expect(preview.blockers).toContain('verified_contact_owners.person_id');
    await expect(createIdentityMergeOperation(env.DB, input)).rejects.toThrow(/hard_conflict/);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM person_merge_operations WHERE resolution_case_id=?1')
      .bind(pair.caseId).first<number>('n')).toBe(0);
  });

  it('submits a normal merge and atomically consumes a bound OTP with its one live approval', async () => {
    const pair = await createConfirmedPair();
    const created = await createIdentityMergeOperation(env.DB, {
      backend: 'd1', caseId: pair.caseId, loserPersonId: pair.loserPersonId,
      canonicalPersonId: pair.canonicalPersonId, requestedByPersonId: pair.requesterPersonId,
      scope: { kind: 'global' }, now: new Date().toISOString(),
    });
    await expect(submitIdentityMergeForApproval(env.DB, {
      operationId: created.operationId, expectedVersion: 1, actorPersonId: pair.requesterPersonId,
    })).resolves.toEqual({ status: 'awaiting_approval', operationId: created.operationId, version: 2 });
    const contactId = nextPersonId();
    const email = `execution-approver-${contactId}@example.test`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)")
        .bind(contactId, email),
      env.DB.prepare("INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source) VALUES(?1,?2,?1,'email','execution-approval')")
        .bind(contactId, pair.requesterPersonId),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')")
        .bind(contactId, pair.requesterPersonId),
    ]);
    const authEnv = { IDENTITY_VERIFICATION_SECRET: 'm'.repeat(64) };
    const requestContext = identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.90' }), 'merge-device');
    const begun = await beginIdentityMergeApproval(env.DB, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId: pair.requesterPersonId,
      campusId: 1, requestContext,
    });
    expect(begun.delivery).toEqual(expect.objectContaining({
      to: email, publicId: expect.any(String), code: expect.stringMatching(/^\d{6}$/), expiresAt: expect.any(String),
    }));
    await expect(completeIdentityMergeApproval(env.DB, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId: pair.requesterPersonId,
      campusId: 1, publicId: begun.delivery.publicId, code: begun.delivery.code === '000000' ? '000001' : '000000',
    })).resolves.toEqual({ status: 'invalid' });
    expect(await env.DB.prepare('SELECT attempts FROM identity_challenges WHERE public_id=?1')
      .bind(begun.delivery.publicId).first<number>('attempts')).toBe(1);
    await expect(completeIdentityMergeApproval(env.DB, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId: pair.requesterPersonId,
      campusId: 1, publicId: begun.delivery.publicId, code: begun.delivery.code,
    })).resolves.toEqual({ status: 'approved', operationId: created.operationId, version: 3 });
    const state = await env.DB.prepare('SELECT state,version FROM person_merge_operations WHERE operation_id=?1')
      .bind(created.operationId).first<{ state: string; version: number }>();
    expect(state).toEqual({ state: 'approved', version: 3 });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM person_merge_approvals WHERE operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(1);
  });

  it('records only a canonical-only privilege decision against the exact preview version', async () => {
    const pair = await createConfirmedPair();
    const created = await createIdentityMergeOperation(env.DB, {
      backend: 'd1', caseId: pair.caseId, loserPersonId: pair.loserPersonId,
      canonicalPersonId: pair.canonicalPersonId, requestedByPersonId: pair.requesterPersonId,
      scope: { kind: 'global' }, now: new Date().toISOString(),
    });
    await expect(recordIdentityMergeDecision(env.DB, {
      operationId: created.operationId, expectedVersion: 1, decidedByPersonId: pair.requesterPersonId,
      category: 'privilege', decision: 'keep_both',
    })).rejects.toThrow(/canonical_only/);
    await expect(recordIdentityMergeDecision(env.DB, {
      operationId: created.operationId, expectedVersion: 1, decidedByPersonId: pair.requesterPersonId,
      category: 'privilege', decision: 'canonical_only',
    })).resolves.toEqual({ status: 'recorded', operationId: created.operationId, version: 1 });
  });

  it('seals and atomically executes core subject repoints with local-row-only journals', async () => {
    const pair = await createConfirmedPair();
    const observationId = nextPersonId();
    const giftId = nextPersonId();
    const noteId = nextPersonId();
    const tokenId = nextPersonId();
    const submissionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO identity_observations(id,campus_id,source,source_key,status,linked_person_id)
        VALUES(?1,1,'import',?2,'linked',?3)`).bind(observationId, `merge:${observationId}`, pair.loserPersonId),
      env.DB.prepare(`INSERT INTO gift_results(id,person_id,top_gifts_json,recommended_json)
        VALUES(?1,?2,'[]','[]')`).bind(giftId, pair.loserPersonId),
      env.DB.prepare(`INSERT INTO person_notes(id,person_id,author_email,body)
        VALUES(?1,?2,'author@example.test','private note body')`).bind(noteId, pair.loserPersonId),
      env.DB.prepare(`INSERT INTO tokens(id,token_hash,person_id,purpose,expires_at,expected_session_epoch)
        VALUES(?1,?2,?3,'login','2035-01-01 00:00:00',0)`)
        .bind(tokenId, `merge-token-${tokenId}`, pair.loserPersonId),
      env.DB.prepare(`INSERT INTO newcomer_submissions(
        id,name,locale,visit_date,source,linked_person_id,campus_id)
        VALUES(?1,'Merge newcomer','en','2030-01-01','staff',?2,1)`).bind(submissionId, pair.loserPersonId),
    ]);
    const sourceEnv = {
      IDENTITY_SOURCE_KEY_SECRET: 'merge-execution-source-key-secret-at-least-thirty-two-characters',
      IDENTITY_SOURCE_KEY_ID: 'merge-execution-v1',
    };
    await env.DB.prepare(`INSERT INTO campus_memberships(campus_id,person_id,role,finance,admin_areas,active)
      VALUES(1,?1,'member',0,'',1)`).bind(pair.loserPersonId).run();
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sourceEnv.IDENTITY_SOURCE_KEY_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const verificationTag = [...new Uint8Array(await crypto.subtle.sign('HMAC', key,
      new TextEncoder().encode(`identity-source-key-config:v1\0${sourceEnv.IDENTITY_SOURCE_KEY_ID}`)))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(`INSERT INTO identity_source_key_config(singleton_id,key_id,algorithm_version,verification_tag)
      VALUES(1,?1,1,?2)`).bind(sourceEnv.IDENTITY_SOURCE_KEY_ID, verificationTag).run();
    const source = await registerIdentitySource(env.DB, sourceEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: `merge-source:${giftId}`,
      email: `merge-source-${giftId}@example.test`, attachmentPolicy: 'signed_in_or_claim',
      sourceDigest: 'd'.repeat(64),
    });
    await attachIdentitySourceForSignedInSession(env.DB, sourceEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
      expectedVersion: 1, sourceDigest: 'd'.repeat(64),
      session: identityGatewaySessionContext({ personId: pair.loserPersonId, campusId: 1, sessionEpoch: 0 }),
    });
    await env.DB.prepare('DELETE FROM campus_memberships WHERE person_id=?1').bind(pair.loserPersonId).run();
    const created = await createIdentityMergeOperation(env.DB, {
      backend: 'd1', caseId: pair.caseId, loserPersonId: pair.loserPersonId,
      canonicalPersonId: pair.canonicalPersonId, requestedByPersonId: pair.requesterPersonId,
      scope: { kind: 'global' }, now: new Date().toISOString(),
    });
    expect(created.preview).toEqual(expect.objectContaining({
      inventoryCount: 7, expectedMutationCount: 7, expectedIrreversibleCount: 1,
    }));
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM person_merge_reference_facts WHERE operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(7);

    await submitIdentityMergeForApproval(env.DB, {
      operationId: created.operationId, expectedVersion: 1, actorPersonId: pair.requesterPersonId,
    });
    const contactId = nextPersonId();
    const email = `execution-subject-approver-${contactId}@example.test`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)")
        .bind(contactId, email),
      env.DB.prepare("INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source) VALUES(?1,?2,?1,'email','execution-approval')")
        .bind(contactId, pair.requesterPersonId),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')")
        .bind(contactId, pair.requesterPersonId),
    ]);
    const authEnv = { IDENTITY_VERIFICATION_SECRET: 'm'.repeat(64) };
    const begun = await beginIdentityMergeApproval(env.DB, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId: pair.requesterPersonId,
      campusId: 1,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.91' }), 'subject-device'),
    });
    await completeIdentityMergeApproval(env.DB, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId: pair.requesterPersonId,
      campusId: 1, publicId: begun.delivery.publicId, code: begun.delivery.code,
    });
    const secondApproverId = nextPersonId();
    const secondContactId = nextPersonId();
    const secondEmail = `execution-subject-second-${secondContactId}@example.test`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(?1,?2,?3,'admin',1)")
        .bind(secondApproverId, `Second approver ${secondApproverId}`, secondEmail),
      env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(?1,'email',?2,?2)")
        .bind(secondContactId, secondEmail),
      env.DB.prepare("INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source) VALUES(?1,?2,?1,'email','execution-approval')")
        .bind(secondContactId, secondApproverId),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(?1,?2,'admin_review')")
        .bind(secondContactId, secondApproverId),
    ]);
    const secondBegun = await beginIdentityMergeApproval(env.DB, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId: secondApproverId,
      campusId: 1,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.92' }), 'subject-device-2'),
    });
    await completeIdentityMergeApproval(env.DB, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId: secondApproverId,
      campusId: 1, publicId: secondBegun.delivery.publicId, code: secondBegun.delivery.code,
    });

    const executionResult = await executeIdentityMerge(env.DB, {
      backend: 'd1', operationId: created.operationId, expectedVersion: 3,
      actorPersonId: pair.requesterPersonId,
    });
    expect(executionResult).toEqual({ status: 'completed', operationId: created.operationId, version: 5, mutationCount: 7 });
    for (const [table, id] of [
      ['identity_observations', observationId], ['gift_results', giftId],
      ['person_notes', noteId], ['newcomer_submissions', submissionId],
    ] as const) {
      expect(await env.DB.prepare(`SELECT linked_person_id AS person_id FROM ${table} WHERE id=?1`)
        .bind(id).first<number>('person_id').catch(async () =>
          env.DB.prepare(`SELECT person_id FROM ${table} WHERE id=?1`).bind(id).first<number>('person_id')))
        .toBe(pair.canonicalPersonId);
    }
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_source_records WHERE id=?1')
      .bind(source.sourceRecordId).first<number>('linked_person_id')).toBe(pair.canonicalPersonId);
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_observations WHERE id=?1')
      .bind(source.observationId).first<number>('linked_person_id')).toBe(pair.canonicalPersonId);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM person_merge_mutation_receipts WHERE operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(7);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM person_merge_journal_row_details WHERE operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(7);
    expect(await env.DB.prepare('SELECT used_at FROM tokens WHERE id=?1')
      .bind(tokenId).first<string>('used_at')).toBeTruthy();
    expect(await env.DB.prepare('SELECT canonical_person_id FROM person_merge_redirects WHERE loser_person_id=?1')
      .bind(pair.loserPersonId).first<number>('canonical_person_id')).toBe(pair.canonicalPersonId);
    expect(await env.DB.prepare('SELECT active FROM people WHERE id=?1')
      .bind(pair.loserPersonId).first<number>('active')).toBe(0);

    const rollback = await createIdentityMergeRollback(env.DB, {
      operationId: created.operationId, expectedVersion: 5, requestedByPersonId: pair.requesterPersonId,
    });
    expect(rollback).toEqual(expect.objectContaining({ status: 'awaiting_approval', version: 2 }));
    const rollbackFirst = await beginIdentityMergeRollbackApproval(env.DB, authEnv, {
      rollbackId: rollback.rollbackId, expectedVersion: 2, approverPersonId: pair.requesterPersonId,
      campusId: 1,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.93' }), 'rollback-1'),
    });
    await expect(completeIdentityMergeRollbackApproval(env.DB, authEnv, {
      rollbackId: rollback.rollbackId, expectedVersion: 2, approverPersonId: pair.requesterPersonId,
      campusId: 1, publicId: rollbackFirst.delivery.publicId, code: rollbackFirst.delivery.code,
    })).resolves.toEqual({ status: 'awaiting_approval', rollbackId: rollback.rollbackId,
      operationId: created.operationId, version: 2 });
    const rollbackSecond = await beginIdentityMergeRollbackApproval(env.DB, authEnv, {
      rollbackId: rollback.rollbackId, expectedVersion: 2, approverPersonId: secondApproverId,
      campusId: 1,
      requestContext: identityTrustedRequestContext(new Headers({ 'CF-Connecting-IP': '203.0.113.94' }), 'rollback-2'),
    });
    await expect(completeIdentityMergeRollbackApproval(env.DB, authEnv, {
      rollbackId: rollback.rollbackId, expectedVersion: 2, approverPersonId: secondApproverId,
      campusId: 1, publicId: rollbackSecond.delivery.publicId, code: rollbackSecond.delivery.code,
    })).resolves.toEqual({ status: 'approved', rollbackId: rollback.rollbackId,
      operationId: created.operationId, version: 3 });
    await expect(executeIdentityMergeRollback(env.DB, {
      rollbackId: rollback.rollbackId, expectedVersion: 3, actorPersonId: pair.requesterPersonId,
    })).resolves.toEqual({ status: 'completed', rollbackId: rollback.rollbackId,
      operationId: created.operationId, version: 5, revertedCount: 6, skippedSecurityCount: 1 });
    expect(await env.DB.prepare('SELECT active FROM people WHERE id=?1')
      .bind(pair.loserPersonId).first<number>('active')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM person_merge_redirects WHERE loser_person_id=?1')
      .bind(pair.loserPersonId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT person_id FROM gift_results WHERE id=?1')
      .bind(giftId).first<number>('person_id')).toBe(pair.loserPersonId);
    expect(await env.DB.prepare('SELECT linked_person_id FROM identity_source_records WHERE id=?1')
      .bind(source.sourceRecordId).first<number>('linked_person_id')).toBe(pair.loserPersonId);
    expect(await env.DB.prepare('SELECT used_at FROM tokens WHERE id=?1')
      .bind(tokenId).first<string>('used_at')).toBeTruthy();
  });
});
