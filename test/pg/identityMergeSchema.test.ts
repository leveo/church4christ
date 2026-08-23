import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_MERGE_RISK_FACT_CATEGORIES } from '../../src/lib/identityMergeModel';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('identity merge operation guards (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const writerSql = hasPg ? pgClient() : (null as never);
  const monitorSql = hasPg ? pgClient() : (null as never);
  let assuranceSequence = 289000;

  const consumeMergeStepUp = async (input: {
    operationId: string; approverPersonId: number; operationVersion?: number;
    previewHash?: string; riskStateHash?: string; campusId?: number;
  }) => {
    const challengeId = ++assuranceSequence;
    const [{ identity_version: identityVersion, session_epoch: sessionEpoch }] = await sql.unsafe(
      'SELECT identity_version,session_epoch FROM people WHERE id=$1', [input.approverPersonId],
    );
    const context = JSON.stringify({ person_merge_approval: {
      operation_id: input.operationId, operation_version: input.operationVersion ?? 2,
      preview_hash: input.previewHash ?? 'a'.repeat(64), risk_state_hash: input.riskStateHash ?? 'b'.repeat(64),
      risk_state_version: 1, resolution_case_version: 1, resolution_case_hash: 'c'.repeat(64),
      approver_person_id: input.approverPersonId, approver_identity_version: identityVersion,
      campus_id: input.campusId ?? 1,
    } });
    const value = `pg-merge-step-up-${challengeId}@example.test`;
    await sql.unsafe("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES($1,'email',$2,$2)", [challengeId, value]);
    await sql.unsafe("INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source) VALUES($1,$2,$1,'email','merge-step-up')", [challengeId, input.approverPersonId]);
    await sql.unsafe("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES($1,$2,'admin_review')", [challengeId, input.approverPersonId]);
    await sql.unsafe(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,request_source,person_id,contact_point_id,
      code_hash,requester_bucket_hash,expires_at,context_json,created_at,expected_session_epoch)
      VALUES($1,$2,$3,'step_up','admin',$4,$1,$5,$5,datetime('now','+5 minutes'),$6,datetime('now'),$7)`, [
      challengeId, `123e4567-e89b-42d3-a456-${String(challengeId).padStart(12, '0')}`,
      input.campusId ?? 1, input.approverPersonId, 'e'.repeat(64), context, sessionEpoch,
    ]);
    await sql.unsafe("UPDATE identity_challenges SET consumed_at=datetime('now') WHERE id=$1", [challengeId]);
    return challengeId;
  };

  const waitFor = async (predicate: () => Promise<boolean>, label: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  };

  const insertPreviewedSubstitutionOperation = async (input: {
    operationId: string;
    caseId: number;
    loser: number;
    canonical: number;
    overrides?: Partial<Record<string, [number, number, number]>>;
    setup?: () => Promise<void>;
  }) => {
    await sql.unsafe(`INSERT INTO people(id,display_name,email) VALUES
      ($1,$2,$3),($4,$5,$6)`, [
      input.loser, `Set loser ${input.loser}`, `set-loser-${input.loser}@example.test`,
      input.canonical, `Set canonical ${input.canonical}`, `set-canonical-${input.canonical}@example.test`,
    ]);
    await input.setup?.();
    await sql.unsafe(`INSERT INTO identity_resolution_cases(
      id,campus_id,person_a_id,person_b_id,score,risk,state,version)
      VALUES($1,1,$2,$3,90,'high','same_person',1)`, [input.caseId, input.loser, input.canonical]);
    await sql.unsafe(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,expected_canonical_identity_version,
      expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,risk,
      risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES($1,$2,$3,$4,1,$5,'campus',1,1,0,1,0,$6,1,'2099-01-01T00:00:00.000Z',
        'high',$7,1,2,'previewed',189103)`, [
      input.operationId, input.loser, input.canonical, input.caseId,
      'c'.repeat(64), 'a'.repeat(64), '9'.repeat(64),
    ]);
    const values = IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category, index) =>
      `($1,$${index * 5 + 2},$${index * 5 + 3},$${index * 5 + 4},$${index * 5 + 5},$${index * 5 + 6},'${'9'.repeat(64)}',1)`).join(',');
    const params: unknown[] = [input.operationId];
    for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
      const [loser, canonical, collision] = input.overrides?.[category]
        ?? (category === 'campus_membership' ? [1, 1, 1] : [0, 0, 0]);
      params.push(category, loser, canonical, loser + canonical, collision);
    }
    await sql.unsafe(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES ${values}`, params);
  };

  const insertApprovedCriticalOperation = async (input: {
    operationId: string;
    caseId: number;
    loser: number;
    canonical: number;
    approverOne: number;
    approverTwo: number;
    scope?: 'global' | 'campus';
  }) => {
    const people = [...new Set([input.loser, input.canonical, input.approverOne, input.approverTwo])];
    for (const personId of people) {
      await sql.unsafe(`INSERT INTO people(id,display_name,email,role,super_admin)
        VALUES($1,$2,$3,'admin',1) ON CONFLICT(id) DO NOTHING`,
      [personId, `Lock person ${personId}`, `lock-${personId}@example.test`]);
    }
    const stepUps = new Map<number, number>();
    for (const approverPersonId of [input.approverOne, input.approverTwo]) {
      stepUps.set(approverPersonId, await consumeMergeStepUp({ operationId: input.operationId, approverPersonId }));
    }
    await sql.unsafe(`INSERT INTO identity_resolution_cases(
      id,campus_id,person_a_id,person_b_id,score,risk,state,version)
      VALUES($1,1,$2,$3,99,'high','same_person',1)`, [input.caseId, input.loser, input.canonical]);
    const scope = input.scope ?? 'global';
    await sql.unsafe(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,expected_canonical_identity_version,
      expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,risk,
      risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,1,0,1,0,$8,1,'2099-01-01T00:00:00.000Z',
        'critical',$9,1,2,'previewed',$10)`, [
      input.operationId, input.loser, input.canonical, input.caseId, 'c'.repeat(64), scope,
      scope === 'campus' ? 1 : null, 'a'.repeat(64), 'b'.repeat(64), input.approverTwo,
    ]);
    const values = IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category, index) =>
      `($1,$${index * 5 + 2},$${index * 5 + 3},$${index * 5 + 4},$${index * 5 + 5},$${index * 5 + 6},'${'b'.repeat(64)}',1)`).join(',');
    const params: unknown[] = [input.operationId];
    const [{ loser_verified: loserVerified, canonical_verified: canonicalVerified,
      loser_links: loserLinks, canonical_links: canonicalLinks }] = await sql.unsafe(`SELECT
        (SELECT count(*)::int FROM verified_contact_owners WHERE person_id=$1) loser_verified,
        (SELECT count(*)::int FROM verified_contact_owners WHERE person_id=$2) canonical_verified,
        (SELECT count(*)::int FROM person_contact_links WHERE person_id=$1 AND ended_at IS NULL) loser_links,
        (SELECT count(*)::int FROM person_contact_links WHERE person_id=$2 AND ended_at IS NULL) canonical_links`,
    [input.loser, input.canonical]);
    for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
      const loserSide = category === 'privilege' || category === 'campus_membership' ? 1
        : (category === 'verified_contact_owner' ? loserVerified : (category === 'contact_link' ? loserLinks : 0));
      const canonicalSide = category === 'privilege' || category === 'campus_membership' ? 1
        : (category === 'verified_contact_owner' ? canonicalVerified : (category === 'contact_link' ? canonicalLinks : 0));
      const collision = category === 'campus_membership' ? 1
        : (category === 'verified_contact_owner' && loserSide > 0 && canonicalSide > 0 ? 1 : 0);
      params.push(category, loserSide, canonicalSide, loserSide + canonicalSide, collision);
    }
    await sql.unsafe(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES ${values}`, params);
    await sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [input.operationId]);
    for (const [category, decision, suffix] of [
      ['privilege', 'canonical_only', input.caseId + 1],
      ['campus_membership', 'dedupe', input.caseId + 2],
      ...((loserVerified + canonicalVerified > 0)
        ? [['contact_owner', 'preserve_history', input.caseId + 6] as const] : []),
    ] as const) {
      await sql.unsafe(`INSERT INTO person_merge_conflict_decisions(
        decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES($1,$2,$3,$4,$5,2,$6,$7,1,1,$8)`, [
        `123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`,
        input.operationId, category, decision, input.approverTwo, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64),
      ]);
    }
    if ((await sql.unsafe(`SELECT 1 FROM planning_center_merge_mapping_snapshots
      WHERE operation_id=$1 LIMIT 1`, [input.operationId]))[0]) {
      await sql.unsafe(`INSERT INTO person_merge_conflict_decisions(
        decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES($1,$2,'external_identity','manual_required',$3,2,$4,$5,1,1,$6)`, [
        `123e4567-e89b-42d3-a456-${String(input.caseId + 5).padStart(12, '0')}`,
        input.operationId, input.approverTwo, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64),
      ]);
    }
    for (const [approver, order, suffix] of [
      [input.approverOne, 1, input.caseId + 3], [input.approverTwo, 2, input.caseId + 4],
    ] as const) {
      await sql.unsafe(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES($1,$2,$3,$4,$5,'approve',2,$6,$7,1,1,$8)`, [
        `123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`,
        input.operationId, approver, stepUps.get(approver), order, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64),
      ]);
    }
    await sql.unsafe("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=$1", [input.operationId]);
  };

  const installTransitionPause = async (operationId: string, barrierKey: number, suffix: number) => {
    const functionName = `person_merge_test_pause_${suffix}`;
    const triggerName = `person_merge_operations_ao_test_pause_${suffix}`;
    await sql.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id='${operationId}' AND NEW.state='executing'
        THEN PERFORM pg_advisory_xact_lock(${barrierKey}); END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON person_merge_operations
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    return async () => {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON person_merge_operations`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    };
  };

  const runTransitionFirstWriterRace = async (input: {
    operationId: string;
    targetPersonId: number;
    barrierKey: number;
    suffix: number;
    writerSql: string;
  }) => {
    const removePause = await installTransitionPause(input.operationId, input.barrierKey, input.suffix);
    let barrierReady!: () => void; let releaseBarrier!: () => void;
    const ready = new Promise<void>((resolve) => { barrierReady = resolve; });
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const barrier = sql.begin(async (tx) => {
      await tx.unsafe('SELECT pg_advisory_xact_lock($1)', [input.barrierKey]);
      barrierReady(); await release;
    });
    await ready;
    try {
      const transition = sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL deadlock_timeout='100ms'");
        await tx.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [input.operationId]);
      });
      await waitFor(async () => Boolean((await monitorSql.unsafe(`SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND objid=$1 LIMIT 1`, [input.barrierKey]))[0]), 'transition pause');
      const writer = writerSql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL deadlock_timeout='100ms'");
        await tx.unsafe(input.writerSql, [input.targetPersonId]);
      });
      await waitFor(async () => Boolean((await monitorSql.unsafe(`SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND objid=$1 LIMIT 1`, [input.targetPersonId]))[0]), 'risk writer advisory wait');
      releaseBarrier();
      const settled = await Promise.allSettled([transition, writer, barrier]);
      expect(settled.every(({ status }) => status === 'fulfilled'), settled.map((item) =>
        item.status === 'rejected' ? String(item.reason) : item.status).join('\n')).toBe(true);
    } finally {
      releaseBarrier();
      await barrier.catch(() => undefined);
      await removePause();
    }
  };

  const insertPlanningCenterMappingFixture = async (input: {
    loser: number;
    canonical: number;
    sourceId: number;
    providerPersonId: string;
  }) => {
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,super_admin) VALUES
      ($1,$2,$3,'admin',1),($4,$5,$6,'admin',1) ON CONFLICT(id) DO NOTHING`, [
      input.loser, `PCO loser ${input.loser}`, `pco-loser-${input.loser}@example.test`,
      input.canonical, `PCO canonical ${input.canonical}`, `pco-canonical-${input.canonical}@example.test`,
    ]);
    await sql.unsafe(`INSERT INTO planning_center_connections(id,campus_id,base_url,organization_id,state)
      VALUES(189800,1,'https://api.planningcenteronline.com','189800','active') ON CONFLICT(id) DO NOTHING`);
    await sql.unsafe(`INSERT INTO identity_source_key_config(singleton_id,key_id,algorithm_version,verification_tag)
      VALUES(1,'merge-v1',1,$1) ON CONFLICT(singleton_id) DO NOTHING`, ['7'.repeat(64)]);
    const sourceKey = input.sourceId.toString(16).padStart(64, '0');
    await sql.unsafe(`INSERT INTO identity_observations(id,campus_id,source,source_key,status)
      VALUES($1,1,'planning_center',$2,'provisional')`, [input.sourceId, sourceKey]);
    await sql.unsafe(`INSERT INTO identity_source_records(
      id,campus_id,source,source_record_key,source_key_id,observation_id,attachment_policy,state,source_digest)
      VALUES($1,1,'planning_center',$2,'merge-v1',$1,'external_review','unlinked',$3)`,
    [input.sourceId, sourceKey, '4'.repeat(64)]);
    await sql.unsafe(`INSERT INTO planning_center_person_mappings(
      connection_id,provider_person_id,source_record_id,person_id,match_state)
      VALUES(189800,$1,$2,$3,'matched')`, [input.providerPersonId, input.sourceId, input.loser]);
  };

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,super_admin) VALUES
      (189101,'PG Merge A','pg-merge-a@example.test','member',0),
      (189102,'PG Merge B','pg-merge-b@example.test','member',0),
      (189103,'PG Merge Admin','pg-merge-admin@example.test','admin',1)`);
    await sql.unsafe("INSERT INTO identity_resolution_cases(id,campus_id,person_a_id,person_b_id,score,risk,state,version) VALUES(189101,1,189101,189102,90,'high','same_person',1)");
  });
  afterAll(async () => { await Promise.all([sql?.end(), writerSql?.end(), monitorSql?.end()]); });

  it('serializes concurrent opposite-direction inserts to one active operation', async () => {
    const insert = (operationId: string, loser: number, canonical: number, hash: string) => sql.unsafe(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,expected_canonical_identity_version,
      expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,risk,
      risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES($1,$2,$3,189101,1,$4,'campus',1,1,0,1,0,$5,1,'2099-01-01T00:00:00.000Z',
        'high',$6,1,2,'previewed',189103)`,
    [operationId, loser, canonical, 'c'.repeat(64), hash, 'd'.repeat(64)]);
    const settled = await Promise.allSettled([
      insert('123e4567-e89b-42d3-a456-426614179101', 189101, 189102, 'a'.repeat(64)),
      insert('123e4567-e89b-42d3-a456-426614179102', 189102, 189101, 'b'.repeat(64)),
    ]);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect((await sql.unsafe("SELECT count(*)::int AS count FROM person_merge_operations WHERE state IN ('previewed','awaiting_approval','approved','executing')"))[0].count).toBe(1);
  });

  it('enforces state CAS and append-only approvals in the real catalog', async () => {
    const [{ operation_id: operationId }] = await sql.unsafe('SELECT operation_id FROM person_merge_operations LIMIT 1');
    const values = IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category, index) =>
      `($1,$${index * 5 + 2},$${index * 5 + 3},$${index * 5 + 4},$${index * 5 + 5},$${index * 5 + 6},'${'d'.repeat(64)}',1)`).join(',');
    const params: unknown[] = [operationId];
    for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
      const side = category === 'campus_membership' ? 1 : 0;
      params.push(category, side, side, side + side, category === 'campus_membership' ? 1 : 0);
    }
    await sql.unsafe(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version) VALUES ${values}`, params);
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval' WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/state_cas/);
    await sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1 AND version=1", [operationId]);
    await sql.unsafe("INSERT INTO people(id,display_name,email,super_admin) VALUES(189104,'PG Member Flag','pg-member-flag@example.test',1)");
    const invalidActorStepUp = await consumeMergeStepUp({ operationId, approverPersonId: 189104, riskStateHash: 'd'.repeat(64) });
    await expect(sql.unsafe(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      SELECT '123e4567-e89b-42d3-a456-426614179110',operation_id,189104,$2,1,'approve',2,preview_hash,
        risk_state_hash,risk_state_version,expected_resolution_case_version,resolution_case_hash
      FROM person_merge_operations WHERE operation_id=$1`, [operationId, invalidActorStepUp])).rejects.toThrow(/requires_master_admin/);
    const firstAdminStepUp = await consumeMergeStepUp({ operationId, approverPersonId: 189103, riskStateHash: 'd'.repeat(64) });
    await sql.unsafe(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      SELECT '123e4567-e89b-42d3-a456-426614179111',operation_id,189103,$2,1,'approve',2,preview_hash,
        risk_state_hash,risk_state_version,expected_resolution_case_version,resolution_case_hash
      FROM person_merge_operations WHERE operation_id=$1`, [operationId, firstAdminStepUp]);
    await expect(sql.unsafe("UPDATE person_merge_approvals SET decision='reject' WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/append_only/);
  });

  it('revalidates each counted approver at approval and execution time', async () => {
    const [{ operation_id: operationId }] = await sql.unsafe("SELECT operation_id FROM person_merge_operations WHERE state='awaiting_approval' LIMIT 1");
    await sql.unsafe("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(189105,'PG Merge Admin Two','pg-merge-admin-two@example.test','admin',1)");
    const secondAdminStepUp = await consumeMergeStepUp({ operationId, approverPersonId: 189105, riskStateHash: 'd'.repeat(64) });
    await sql.unsafe(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      SELECT '123e4567-e89b-42d3-a456-426614179112',operation_id,189105,$2,2,'approve',2,preview_hash,
        risk_state_hash,risk_state_version,expected_resolution_case_version,resolution_case_hash
      FROM person_merge_operations WHERE operation_id=$1`, [operationId, secondAdminStepUp]);
    await sql.unsafe(`INSERT INTO person_merge_conflict_decisions(
      decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      SELECT '123e4567-e89b-42d3-a456-426614179113',operation_id,'campus_membership','dedupe',189103,2,
        preview_hash,risk_state_hash,risk_state_version,expected_resolution_case_version,resolution_case_hash
      FROM person_merge_operations WHERE operation_id=$1`, [operationId]);
    await sql.unsafe('UPDATE people SET active=0 WHERE id=189103');
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/approval_eligibility/);
    await sql.unsafe('UPDATE people SET active=1 WHERE id=189103');
    await sql.unsafe("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=$1", [operationId]);
    await sql.unsafe("UPDATE people SET auth_disabled_at=datetime('now') WHERE id=189105");
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/approval_eligibility/);
  });

  it('serializes a live-risk writer ahead of transition and rejects the stale snapshot', async () => {
    await sql.unsafe(`INSERT INTO people(id,display_name,email) VALUES
      (189201,'PG Risk A','pg-risk-a@example.test'),
      (189202,'PG Risk B','pg-risk-b@example.test')`);
    await sql.unsafe("INSERT INTO identity_resolution_cases(id,campus_id,person_a_id,person_b_id,score,risk,state,version) VALUES(189201,1,189201,189202,90,'high','same_person',1)");
    const operationId = '123e4567-e89b-42d3-a456-426614179120';
    await sql.unsafe(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,expected_canonical_identity_version,
      expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,risk,
      risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES($1,189201,189202,189201,1,$2,'campus',1,1,0,1,0,$3,1,'2099-01-01T00:00:00.000Z',
        'high',$4,1,2,'previewed',189103)`, [operationId, 'c'.repeat(64), 'a'.repeat(64), 'e'.repeat(64)]);
    const values = IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category, index) =>
      `($1,$${index * 5 + 2},$${index * 5 + 3},$${index * 5 + 4},$${index * 5 + 5},$${index * 5 + 6},'${'e'.repeat(64)}',1)`).join(',');
    const params: unknown[] = [operationId];
    for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
      const side = category === 'campus_membership' ? 1 : 0;
      params.push(category, side, side, side + side, category === 'campus_membership' ? 1 : 0);
    }
    await sql.unsafe(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES ${values}`, params);
    let writerLocked!: () => void; let releaseWriter!: () => void;
    const writerEntered = new Promise<void>((resolve) => { writerLocked = resolve; });
    const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = sql.begin(async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(189201)");
      writerLocked(); await writerRelease;
      await tx.unsafe("INSERT INTO person_interests(person_id,category) VALUES(189201,'pg-race')");
    });
    await writerEntered;
    const transition = sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]);
    releaseWriter(); await writer;
    await expect(transition).rejects.toThrow(/risk_(source|set)_stale/);
  });

  it('rejects same-side privilege composition drift with unchanged counts', async () => {
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role) VALUES
      (189211,'PG Composition A','pg-composition-a@example.test','admin'),
      (189212,'PG Composition B','pg-composition-b@example.test','member')`);
    await sql.unsafe("INSERT INTO identity_resolution_cases(id,campus_id,person_a_id,person_b_id,score,risk,state,version) VALUES(189211,1,189211,189212,90,'high','same_person',1)");
    const operationId = '123e4567-e89b-42d3-a456-426614179121';
    await sql.unsafe(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,expected_canonical_identity_version,
      expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,risk,
      risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES($1,189211,189212,189211,1,$2,'global',NULL,1,0,1,0,$3,1,'2099-01-01T00:00:00.000Z',
        'critical',$4,1,2,'previewed',189103)`, [operationId, 'c'.repeat(64), 'a'.repeat(64), 'e'.repeat(64)]);
    const values = IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category, index) =>
      `($1,$${index * 5 + 2},$${index * 5 + 3},$${index * 5 + 4},$${index * 5 + 5},$${index * 5 + 6},'${'e'.repeat(64)}',1)`).join(',');
    const params: unknown[] = [operationId];
    for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
      const loser = category === 'privilege' || category === 'campus_membership' ? 1 : 0;
      const canonical = category === 'campus_membership' ? 1 : 0;
      params.push(category, loser, canonical, loser + canonical, category === 'campus_membership' ? 1 : 0);
    }
    await sql.unsafe(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES ${values}`, params);
    await sql.unsafe("UPDATE people SET role='member',finance=1 WHERE id=189211");
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/risk_set_stale/);
  });

  it('rejects campus A-to-B substitution with unchanged membership counts', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179180';
    await insertPreviewedSubstitutionOperation({ operationId, caseId: 189701, loser: 189701, canonical: 189702 });
    await sql.unsafe("INSERT INTO campuses(id,slug,name) VALUES(189799,'pg-replacement-campus','PG Replacement Campus')");
    await sql.begin(async (tx) => {
      await tx.unsafe('UPDATE campus_memberships SET active=0 WHERE campus_id=1 AND person_id=189701');
      await tx.unsafe(`INSERT INTO campus_memberships(campus_id,person_id,role,finance,admin_areas,active)
        VALUES(189799,189701,'member',0,'',1)`);
    });
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/risk_set_stale/);
  });

  it('rejects group and team role replacement with unchanged membership counts', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179181';
    await insertPreviewedSubstitutionOperation({
      operationId, caseId: 189711, loser: 189711, canonical: 189712,
      overrides: { group_membership: [1, 0, 0], team_membership: [1, 0, 0] },
      setup: async () => {
        await sql.unsafe("INSERT INTO ministries(id,slug,category) VALUES(189711,'pg-merge-ministry','service')");
        await sql.unsafe('INSERT INTO teams(id,ministry_id) VALUES(189711,189711)');
        await sql.unsafe("INSERT INTO groups(id,name,description,is_public) VALUES(189711,'PG Merge Group','',0)");
        await sql.unsafe(`INSERT INTO group_members(id,group_id,person_id,display_name,is_admin)
          VALUES(189711,189711,189711,'PG Merge Member',0)`);
        await sql.unsafe('INSERT INTO team_members(team_id,person_id,is_leader) VALUES(189711,189711,0)');
      },
    });
    await sql.begin(async (tx) => {
      await tx.unsafe('UPDATE group_members SET is_admin=1 WHERE id=189711');
      await tx.unsafe('UPDATE team_members SET is_leader=1 WHERE team_id=189711 AND person_id=189711');
    });
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/risk_set_stale/);
  });

  it('rejects contact and credential identity replacement with unchanged counts', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179182';
    await insertPreviewedSubstitutionOperation({
      operationId, caseId: 189721, loser: 189721, canonical: 189722,
      overrides: { contact_link: [1, 0, 0], active_credential: [1, 0, 0] },
      setup: async () => {
        await sql.unsafe(`INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES
          (189721,'email','pg-old-189721@example.test','pg-old-189721@example.test'),
          (189722,'email','pg-new-189722@example.test','pg-new-189722@example.test')`);
        await sql.unsafe(`INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source)
          VALUES(189721,189721,189721,'email','test')`);
        await sql.unsafe(`INSERT INTO tokens(id,token_hash,person_id,purpose,expires_at)
          VALUES(189721,$1,189721,'respond','2099-01-01T00:00:00.000Z')`, ['1'.repeat(64)]);
      },
    });
    await sql.begin(async (tx) => {
      await tx.unsafe("UPDATE person_contact_links SET ended_at=NOW() WHERE id=189721");
      await tx.unsafe(`INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source)
        VALUES(189722,189721,189722,'email','test')`);
      await tx.unsafe('UPDATE tokens SET used_at=NOW() WHERE id=189721');
      await tx.unsafe(`INSERT INTO tokens(id,token_hash,person_id,purpose,expires_at)
        VALUES(189722,$1,189721,'respond','2099-01-01T00:00:00.000Z')`, ['2'.repeat(64)]);
    });
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/risk_set_stale/);
  });

  it.each([
    {
      label: 'Stripe customer', category: 'stripe_customer', base: 190001,
      setup: async (personId: number) => {
        await sql.unsafe("UPDATE people SET stripe_customer_id='cus_pg_merge_original' WHERE id=$1", [personId]);
      },
      mutate: async (personId: number) => {
        await expect(sql.unsafe(`UPDATE people SET stripe_customer_id='cus_pg_merge_bypass',
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version+1 WHERE id=$1`, [personId]))
          .rejects.toThrow(/semantic_binding_version_invalid/);
        await expect(sql.unsafe(`UPDATE people SET
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version+2 WHERE id=$1`, [personId]))
          .rejects.toThrow(/semantic_binding_version_invalid/);
        await sql.unsafe(`UPDATE people SET
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version+1 WHERE id=$1`, [personId]);
        await expect(sql.unsafe(`UPDATE people SET
          merge_stripe_customer_binding_version=merge_stripe_customer_binding_version-1 WHERE id=$1`, [personId]))
          .rejects.toThrow(/semantic_binding_version_invalid/);
        await sql.unsafe("UPDATE people SET stripe_customer_id='cus_pg_merge_replacement' WHERE id=$1", [personId]);
      },
    },
    {
      label: 'calendar bearer', category: 'active_credential', base: 190011,
      setup: async (personId: number) => {
        await sql.unsafe("UPDATE people SET calendar_token='calendar-pg-merge-original' WHERE id=$1", [personId]);
      },
      mutate: async (personId: number) => {
        await sql.unsafe("UPDATE people SET calendar_token='calendar-pg-merge-replacement' WHERE id=$1", [personId]);
      },
    },
    {
      label: 'external provider identity', category: 'external_identity', base: 190021,
      setup: async (personId: number) => {
        await sql.unsafe(`INSERT INTO person_external_identities(
          id,person_id,provider,organization_id,external_person_id)
          VALUES(190021,$1,'planning_center','100','200')`, [personId]);
        return 190021;
      },
      mutate: async (_personId: number, identityId?: number) => {
        await sql.unsafe(`UPDATE person_external_identities
          SET organization_id='101',external_person_id='201' WHERE id=$1`, [identityId]);
      },
    },
    {
      label: 'learning provider identity', category: 'learning_identity', base: 190031,
      setup: async (personId: number) => {
        await sql.unsafe(`INSERT INTO learning_provider_connections(id,provider,display_name,status)
          VALUES(190031,'google_classroom','PG Merge Learning','active')`);
        await sql.unsafe(`INSERT INTO learning_identity_links(
          id,connection_id,person_id,external_user_id,status)
          VALUES(190031,190031,$1,'learning-pg-original','active')`, [personId]);
        return 190031;
      },
      mutate: async (_personId: number, identityId?: number) => {
        await sql.unsafe("UPDATE learning_identity_links SET external_user_id='learning-pg-replacement' WHERE id=$1", [identityId]);
      },
    },
    {
      label: 'canonical identity key', category: 'canonical_key', base: 190041,
      setup: async (personId: number) => {
        await sql.unsafe(`UPDATE identity_person_canonical_keys
          SET legacy_email_key='canonical-pg-original',normalized_name_key='canonical-pg-original-name',
            normalization_version=1,is_current=1 WHERE person_id=$1`, [personId]);
      },
      mutate: async (personId: number) => {
        await sql.unsafe(`UPDATE identity_person_canonical_keys
          SET legacy_email_key='canonical-pg-replacement',normalized_name_key='canonical-pg-replacement-name'
          WHERE person_id=$1`, [personId]);
      },
    },
    {
      label: 'recurring Stripe subscription', category: 'stripe_recurring', base: 190051,
      setup: async (personId: number) => {
        await sql.unsafe(`INSERT INTO funds(id,fund_number) VALUES(190051,'MERGE-190051') ON CONFLICT(id) DO NOTHING`);
        await sql.unsafe(`INSERT INTO recurring_gifts(
          id,person_id,fund_id,amount_cents,currency,"interval",stripe_subscription_id,status)
          VALUES(190051,$1,190051,1000,'usd','month','sub_pg_merge_original','active')`, [personId]);
        return 190051;
      },
      mutate: async (_personId: number, giftId?: number) => {
        await sql.unsafe("UPDATE recurring_gifts SET stripe_subscription_id='sub_pg_merge_replacement' WHERE id=$1", [giftId]);
      },
    },
  ])('rejects a same-row $label substitution without exposing its value', async ({ category, base, setup, mutate }) => {
    const operationId = `123e4567-e89b-42d3-a456-${String(base).padStart(12, '0')}`;
    await insertPreviewedSubstitutionOperation({
      operationId, caseId: base, loser: base, canonical: base + 1,
      overrides: { [category]: [1, 0, 0] }, setup: async () => { await setup(base); },
    });
    const snapshot = await sql.unsafe(`SELECT item_key FROM person_merge_risk_set_facts
      WHERE operation_id=$1 AND category=$2`, [operationId, category]);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].item_key).not.toMatch(/cus_pg_merge|calendar-pg-merge|planning_center|:100|:200|learning-pg-original|canonical-pg-original|sub_pg_merge/);
    const sourceId = category === 'external_identity' || category === 'learning_identity' || category === 'stripe_recurring'
      ? base : undefined;
    await mutate(base, sourceId);
    const live = await sql.unsafe(`SELECT item_key FROM person_merge_live_risk_set
      WHERE operation_id=$1 AND category=$2`, [operationId, category]);
    expect(live).toHaveLength(1);
    expect(live[0].item_key).not.toBe(snapshot[0].item_key);
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/risk_(facts|set)_stale/);
  });

  it('keeps exact set facts preview-bound, append-only, non-PII, and schema-aligned', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179183';
    await insertPreviewedSubstitutionOperation({ operationId, caseId: 189731, loser: 189731, canonical: 189732 });
    await expect(sql.unsafe(`INSERT INTO person_merge_risk_set_facts(operation_id,category,side,item_key)
      VALUES($1,'source_record','loser','record:fake:owner:linked')`, [operationId]))
      .rejects.toThrow(/risk_set_fact_binding/);
    await expect(sql.unsafe('DELETE FROM person_merge_risk_set_facts WHERE operation_id=$1', [operationId]))
      .rejects.toThrow(/risk_set_append_only/);
    const columns = await sql.unsafe(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='person_merge_risk_set_facts' ORDER BY ordinal_position`);
    expect(columns.map(({ column_name }) => column_name)).toEqual(['operation_id', 'category', 'side', 'item_key']);
    expect(columns.map(({ column_name }) => column_name).join(' ')).not.toMatch(/email|phone|token|amount|note|answer|payload/i);
  });

  it('blocks constant-count source ownership replacement at its writer boundary', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179184';
    await insertPreviewedSubstitutionOperation({
      operationId, caseId: 189741, loser: 189741, canonical: 189742,
      overrides: { source_record: [1, 0, 0] },
      setup: async () => {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL session_replication_role='replica'");
          await tx.unsafe(`INSERT INTO identity_source_key_config(singleton_id,key_id,algorithm_version,verification_tag)
            VALUES(1,'merge-v1',1,$1) ON CONFLICT(singleton_id) DO NOTHING`, ['7'.repeat(64)]);
          await tx.unsafe(`INSERT INTO identity_observations(
            id,campus_id,source,source_key,status,linked_person_id)
            VALUES(189741,1,'giving',$1,'linked',189741)`, ['6'.repeat(64)]);
          await tx.unsafe(`INSERT INTO identity_source_records(
            id,campus_id,source,source_record_key,source_key_id,observation_id,attachment_policy,
            linked_person_id,state,source_digest)
            VALUES(189741,1,'giving',$1,'merge-v1',189741,'signed_in_or_claim',189741,'linked',$2)`,
          ['6'.repeat(64), '5'.repeat(64)]);
        });
      },
    });
    await expect(sql.unsafe('UPDATE identity_source_records SET linked_person_id=189742 WHERE id=189741'))
      .rejects.toThrow(/identity_source_attachment_immutable/);
    const snapshot = await sql.unsafe(`SELECT item_key FROM person_merge_risk_set_facts
      WHERE operation_id=$1 AND category='source_record'`, [operationId]);
    expect(snapshot).toEqual([{ item_key: 'record:189741:campus:1:source:giving:state:linked:owner:linked' }]);
    expect(snapshot[0].item_key).not.toContain('6'.repeat(64));
  });

  it('freezes the PostgreSQL journal registry after migration seed', async () => {
    await expect(sql.unsafe("INSERT INTO person_merge_registry_keys(reference_key,policy) VALUES('fake_table.person_id','subject_repoint')"))
      .rejects.toThrow(/append_only/);
  });

  it('rejects campus-member approval bindings and revalidates campus admin role at approval and execution', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614190071';
    const target = { loser: 190071, canonical: 190072, caseId: 190071 };
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,super_admin) VALUES
      (190071,'PG Campus Loser','pg-campus-loser@example.test','member',0),
      (190072,'PG Campus Canonical','pg-campus-canonical@example.test','member',0),
      (190073,'PG Campus Admin A','pg-campus-admin-a@example.test','admin',1),
      (190074,'PG Campus Admin B','pg-campus-admin-b@example.test','admin',1),
      (190075,'PG Campus Member','pg-campus-member@example.test','admin',1)`);
    await sql.unsafe("UPDATE campus_memberships SET role='member' WHERE person_id=190075 AND campus_id=1");
    await sql.unsafe(`INSERT INTO identity_resolution_cases(
      id,campus_id,person_a_id,person_b_id,score,risk,state,version)
      VALUES($1,1,$2,$3,90,'high','same_person',1)`, [target.caseId, target.loser, target.canonical]);
    await sql.unsafe(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,expected_canonical_identity_version,
      expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,risk,
      risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES($1,$2,$3,$4,1,$5,'campus',1,1,0,1,0,$6,1,'2099-01-01T00:00:00.000Z',
        'high',$7,1,2,'previewed',190073)`, [
      operationId, target.loser, target.canonical, target.caseId, 'c'.repeat(64), 'a'.repeat(64), 'b'.repeat(64),
    ]);
    const values = IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category, index) =>
      `($1,$${index * 5 + 2},$${index * 5 + 3},$${index * 5 + 4},$${index * 5 + 5},$${index * 5 + 6},'${'b'.repeat(64)}',1)`).join(',');
    const params: unknown[] = [operationId];
    for (const category of IDENTITY_MERGE_RISK_FACT_CATEGORIES) {
      const side = category === 'campus_membership' ? 1 : 0;
      params.push(category, side, side, side + side, category === 'campus_membership' ? 1 : 0);
    }
    await sql.unsafe(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES ${values}`, params);
    await sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]);

    const memberStepUp = await consumeMergeStepUp({ operationId, approverPersonId: 190075 });
    await expect(sql.unsafe(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614190075',$1,190075,$2,1,'approve',2,$3,$4,1,1,$5)`,
    [operationId, memberStepUp, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]))
      .rejects.toThrow(/requires_master_admin|step_up_invalid/);

    for (const [approver, order, suffix] of [[190073, 1, 190076], [190074, 2, 190077]] as const) {
      const stepUp = await consumeMergeStepUp({ operationId, approverPersonId: approver });
      await sql.unsafe(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES($1,$2,$3,$4,$5,'approve',2,$6,$7,1,1,$8)`, [
        `123e4567-e89b-42d3-a456-${String(suffix).padStart(12, '0')}`, operationId, approver, stepUp, order,
        'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64),
      ]);
    }
    await sql.unsafe(`INSERT INTO person_merge_conflict_decisions(
      decision_id,operation_id,category,decision,decided_by_person_id,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614190078',$1,'campus_membership','dedupe',190073,2,$2,$3,1,1,$4)`,
    [operationId, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);

    await sql.unsafe("UPDATE campus_memberships SET role='member' WHERE person_id=190073 AND campus_id=1");
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/approval_eligibility/);
    await sql.unsafe("UPDATE campus_memberships SET role='admin' WHERE person_id=190073 AND campus_id=1");
    await sql.unsafe("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=$1", [operationId]);
    await sql.unsafe("UPDATE campus_memberships SET role='member' WHERE person_id=190074 AND campus_id=1");
    await expect(sql.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [operationId]))
      .rejects.toThrow(/approval_eligibility/);
  });

  it('serializes a late veto insert ahead of execution and makes the transition observe it', async () => {
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,super_admin) VALUES
      (189301,'PG Veto Loser','pg-veto-loser@example.test','member',0),
      (189302,'PG Veto Canonical','pg-veto-canonical@example.test','member',0),
      (189303,'PG Veto Admin','pg-veto-admin@example.test','admin',1)`);
    await sql.unsafe('UPDATE campus_memberships SET active=0 WHERE person_id IN (189301,189302)');
    await sql.unsafe("INSERT INTO identity_resolution_cases(id,campus_id,person_a_id,person_b_id,score,risk,state,version) VALUES(189301,1,189301,189302,90,'normal','same_person',1)");
    const operationId = '123e4567-e89b-42d3-a456-426614179130';
    await sql.unsafe(`INSERT INTO person_merge_operations(
      operation_id,loser_person_id,canonical_person_id,resolution_case_id,
      expected_resolution_case_version,resolution_case_hash,scope_kind,campus_id,
      expected_loser_identity_version,expected_loser_session_epoch,expected_canonical_identity_version,
      expected_canonical_session_epoch,preview_hash,preview_version,preview_expires_at,risk,
      risk_state_hash,risk_state_version,required_approvals,state,requested_by_person_id)
      VALUES($1,189301,189302,189301,1,$2,'global',NULL,1,0,1,0,$3,1,'2099-01-01T00:00:00.000Z',
        'normal',$4,1,1,'previewed',189103)`, [operationId, 'c'.repeat(64), 'a'.repeat(64), 'f'.repeat(64)]);
    const values = IDENTITY_MERGE_RISK_FACT_CATEGORIES.map((category, index) =>
      `($1,$${index + 2},0,0,0,0,'${'f'.repeat(64)}',1)`).join(',');
    await sql.unsafe(`INSERT INTO person_merge_risk_facts(
      operation_id,category,loser_count,canonical_count,presence_count,collision_count,risk_state_hash,risk_state_version)
      VALUES ${values}`, [operationId, ...IDENTITY_MERGE_RISK_FACT_CATEGORIES]);
    await sql.unsafe("UPDATE person_merge_operations SET state='awaiting_approval',version=2 WHERE operation_id=$1", [operationId]);
    const vetoApprovalStepUp = await consumeMergeStepUp({ operationId, approverPersonId: 189103, riskStateHash: 'f'.repeat(64) });
    await sql.unsafe(`INSERT INTO person_merge_approvals(
      approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
      expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
      expected_resolution_case_version,expected_resolution_case_hash)
      VALUES('123e4567-e89b-42d3-a456-426614179131',$1,189103,$2,1,'approve',2,$3,$4,1,1,$5)`,
    [operationId, vetoApprovalStepUp, 'a'.repeat(64), 'f'.repeat(64), 'c'.repeat(64)]);
    await sql.unsafe("UPDATE person_merge_operations SET state='approved',version=3 WHERE operation_id=$1", [operationId]);

    let vetoInserted!: () => void; let releaseVeto!: () => void;
    const vetoReady = new Promise<void>((resolve) => { vetoInserted = resolve; });
    const vetoRelease = new Promise<void>((resolve) => { releaseVeto = resolve; });
    const vetoStepUp = await consumeMergeStepUp({ operationId, approverPersonId: 189303, operationVersion: 3, riskStateHash: 'f'.repeat(64) });
    const veto = sql.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO person_merge_approvals(
        approval_id,operation_id,approver_person_id,step_up_challenge_id,approval_order,decision,expected_operation_version,
        expected_preview_hash,expected_risk_state_hash,expected_risk_state_version,
        expected_resolution_case_version,expected_resolution_case_hash)
        VALUES('123e4567-e89b-42d3-a456-426614179132',$1,189303,$2,2,'reject',3,$3,$4,1,1,$5)`,
      [operationId, vetoStepUp, 'a'.repeat(64), 'f'.repeat(64), 'c'.repeat(64)]);
      vetoInserted(); await vetoRelease;
    });
    await vetoReady;
    let transitionSettled = false;
    const transition = sql.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [operationId])
      .finally(() => { transitionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transitionSettled).toBe(false);
    releaseVeto(); await veto;
    await expect(transition).rejects.toThrow(/veto/);
  });

  it('does not deadlock when an approver merge target profile writer starts after transition serialization', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179140';
    await insertApprovedCriticalOperation({
      operationId, caseId: 189401, loser: 189401, canonical: 189402,
      approverOne: 189401, approverTwo: 189403,
    });
    await runTransitionFirstWriterRace({
      operationId, targetPersonId: 189401, barrierKey: 9189401, suffix: 189401,
      writerSql: 'UPDATE people SET active=0 WHERE id=$1',
    });
    expect((await sql.unsafe('SELECT state FROM person_merge_operations WHERE operation_id=$1', [operationId]))[0].state)
      .toBe('executing');
    expect((await sql.unsafe('SELECT active FROM people WHERE id=189401'))[0].active).toBe(0);
  });

  it('does not deadlock when an approver target campus-membership writer starts after transition serialization', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179150';
    await insertApprovedCriticalOperation({
      operationId, caseId: 189501, loser: 189501, canonical: 189502,
      approverOne: 189501, approverTwo: 189503, scope: 'campus',
    });
    await runTransitionFirstWriterRace({
      operationId, targetPersonId: 189501, barrierKey: 9189501, suffix: 189501,
      writerSql: 'UPDATE campus_memberships SET active=0 WHERE person_id=$1 AND campus_id=1',
    });
    expect((await sql.unsafe('SELECT state FROM person_merge_operations WHERE operation_id=$1', [operationId]))[0].state)
      .toBe('executing');
    expect((await sql.unsafe('SELECT active FROM campus_memberships WHERE person_id=189501 AND campus_id=1'))[0].active).toBe(0);
  });

  it('serializes a step-up revocation writer first and rejects the now-ineligible transition', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179151';
    await insertApprovedCriticalOperation({
      operationId, caseId: 189521, loser: 189521, canonical: 189522,
      approverOne: 189523, approverTwo: 189524,
    });
    const [{ step_up_challenge_id: challengeId }] = await sql.unsafe(`SELECT step_up_challenge_id
      FROM person_merge_approvals WHERE operation_id=$1 AND approval_order=1`, [operationId]);
    let writerReady!: () => void; let releaseWriter!: () => void;
    const ready = new Promise<void>((resolve) => { writerReady = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = writerSql.begin(async (tx) => {
      await tx.unsafe("UPDATE identity_challenges SET superseded_at=datetime('now') WHERE id=$1", [challengeId]);
      writerReady(); await release;
    });
    await ready;
    let transitionSettled = false;
    const transition = sql.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [operationId])
      .finally(() => { transitionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transitionSettled).toBe(false);
    releaseWriter(); await writer;
    await expect(transition).rejects.toThrow(/approval_eligibility/);
  });

  it('serializes transition-first against a Planning Center mapping writer and rejects the late writer', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179190';
    await insertPlanningCenterMappingFixture({ loser: 189801, canonical: 189802, sourceId: 189801, providerPersonId: '189801' });
    await insertApprovedCriticalOperation({
      operationId, caseId: 189801, loser: 189801, canonical: 189802,
      approverOne: 189803, approverTwo: 189804,
    });
    await expect(sql.unsafe(`INSERT INTO planning_center_merge_mapping_snapshots(
      operation_id,side,connection_id,provider_person_id,source_record_id)
      SELECT operation_id,'canonical',connection_id,provider_person_id,source_record_id
      FROM planning_center_merge_mapping_snapshots WHERE operation_id=$1 LIMIT 1`, [operationId]))
      .rejects.toThrow(/snapshots_sealed/);
    await expect(sql.unsafe('DELETE FROM planning_center_merge_mapping_snapshot_seals WHERE operation_id=$1', [operationId]))
      .rejects.toThrow(/append_only/);
    const removePause = await installTransitionPause(operationId, 9189801, 189801);
    let barrierReady!: () => void; let releaseBarrier!: () => void;
    const ready = new Promise<void>((resolve) => { barrierReady = resolve; });
    const release = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    const barrier = sql.begin(async (tx) => {
      await tx.unsafe('SELECT pg_advisory_xact_lock(9189801)');
      barrierReady(); await release;
    });
    await ready;
    let transition: PromiseLike<unknown> | undefined;
    let writer: PromiseLike<unknown> | undefined;
    try {
      transition = sql.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [operationId])
        .finally(() => undefined);
      await waitFor(async () => Boolean((await monitorSql.unsafe(`SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND objid=9189801 LIMIT 1`))[0]), 'PCO transition pause');
      writer = writerSql.unsafe(`UPDATE planning_center_person_mappings SET person_id=189802
        WHERE connection_id=189800 AND provider_person_id='189801'`).finally(() => undefined);
      await waitFor(async () => Boolean((await monitorSql.unsafe(`SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND objid=189801 LIMIT 1`))[0]), 'PCO writer person lock');
      releaseBarrier();
      await transition;
      await expect(writer).rejects.toThrow(/planning_center_mapping_merge_executing/);
    } finally {
      releaseBarrier();
      await barrier.catch(() => undefined);
      await Promise.allSettled([...(transition ? [transition] : []), ...(writer ? [writer] : [])]);
      await removePause();
    }
  });

  it('serializes a Planning Center mapping writer first and rejects the now-stale transition', async () => {
    const operationId = '123e4567-e89b-42d3-a456-426614179191';
    await insertPlanningCenterMappingFixture({ loser: 189811, canonical: 189812, sourceId: 189811, providerPersonId: '189811' });
    await insertApprovedCriticalOperation({
      operationId, caseId: 189811, loser: 189811, canonical: 189812,
      approverOne: 189813, approverTwo: 189814,
    });
    let writerReady!: () => void; let releaseWriter!: () => void;
    const ready = new Promise<void>((resolve) => { writerReady = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = writerSql.begin(async (tx) => {
      await tx.unsafe(`UPDATE planning_center_person_mappings SET person_id=189812
        WHERE connection_id=189800 AND provider_person_id='189811'`);
      writerReady(); await release;
    });
    await ready;
    const transition = sql.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [operationId])
      .finally(() => undefined);
    try {
      await waitFor(async () => Boolean((await monitorSql.unsafe(`SELECT 1 FROM pg_locks
        WHERE locktype='advisory' AND NOT granted AND objid=189811 LIMIT 1`))[0]), 'PCO transition person lock');
      releaseWriter(); await writer;
      await expect(transition).rejects.toThrow(/planning_center_merge_mapping_stale/);
    } finally {
      releaseWriter();
      await Promise.allSettled([writer, transition]);
    }
  });

  it('serializes overlapping pair and approver lock sets in one global person-id order', async () => {
    const firstOperation = '123e4567-e89b-42d3-a456-426614179160';
    const secondOperation = '123e4567-e89b-42d3-a456-426614179170';
    await insertApprovedCriticalOperation({
      operationId: firstOperation, caseId: 189601, loser: 189601, canonical: 189602,
      approverOne: 189603, approverTwo: 189604,
    });
    await insertApprovedCriticalOperation({
      operationId: secondOperation, caseId: 189611, loser: 189603, canonical: 189604,
      approverOne: 189605, approverTwo: 189606,
    });
    const settled = await Promise.allSettled([
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL deadlock_timeout='100ms'");
        await tx.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [firstOperation]);
      }),
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL deadlock_timeout='100ms'");
        await tx.unsafe("UPDATE person_merge_operations SET state='executing',version=4 WHERE operation_id=$1", [secondOperation]);
      }),
    ]);
    expect(settled.every(({ status }) => status === 'fulfilled'), settled.map((item) =>
      item.status === 'rejected' ? String(item.reason) : item.status).join('\n')).toBe(true);
  });
});
