import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../../src/lib/appDb';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { identityTrustedRequestContext } from '../../src/lib/identityAuth';
import {
  beginIdentityMergeApproval,
  beginIdentityMergeRollbackApproval,
  completeIdentityMergeApproval,
  completeIdentityMergeRollbackApproval,
  createIdentityMergeOperation,
  createIdentityMergeRollback,
  executeIdentityMerge,
  executeIdentityMergeRollback,
  submitIdentityMergeForApproval,
} from '../../src/lib/identityMergeExecution';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

class DriftBeforeCoreMutationDb implements AppDb {
  constructor(
    private readonly base: PgAdapter,
    private readonly giftResultId: number,
    private readonly driftPersonId: number,
  ) {}
  prepare(sql: string): AppStatement { return this.base.prepare(sql); }
  snapshotBatch<T>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    return this.base.snapshotBatch<T>(statements);
  }
  batch<T>(statements: AppStatement[]): Promise<AppDbResult<T>[]> {
    let replaced = false;
    return this.base.batch<T>(statements.map((statement) => {
      const sqlText = (statement as AppStatement & { sqlText?: string }).sqlText ?? '';
      if (!replaced && sqlText.includes('UPDATE gift_results SET person_id=?3')) {
        replaced = true;
        // Models a competing writer changing the sealed row after the receipt
        // precondition but before this handler's conditional UPDATE (0 rows).
        return this.base.prepare('UPDATE gift_results SET person_id=?2 WHERE id=?1')
          .bind(this.giftResultId, this.driftPersonId);
      }
      return statement;
    }));
  }
}

describe.skipIf(!hasPg)('identity merge execution and rollback (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const db = hasPg ? new PgAdapter(sql) : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
  }, 60_000);
  afterAll(async () => { await sql?.end(); });

  it('atomically rejects rollback drift, then executes the sealed rollback after the row is restored', async () => {
    const loserPersonId = 196001;
    const canonicalPersonId = 196002;
    const approverPersonId = 196003;
    const driftPersonId = 196004;
    const contactPointId = 196010;
    const giftResultId = 196020;
    const resolutionCaseId = 196030;
    const email = 'merge-pg-approver@example.test';
    await sql.unsafe(`INSERT INTO people(id,display_name,email,role,super_admin) VALUES
      ($1,'PG loser','merge-pg-loser@example.test','member',0),
      ($2,'PG canonical','merge-pg-canonical@example.test','member',0),
      ($3,'PG approver',$5,'admin',1),
      ($4,'PG drift','merge-pg-drift@example.test','member',0)`,
    [loserPersonId, canonicalPersonId, approverPersonId, driftPersonId, email]);
    await sql.unsafe('DELETE FROM campus_memberships WHERE person_id IN ($1,$2,$3)',
      [loserPersonId, canonicalPersonId, driftPersonId]);
    await sql.unsafe(`INSERT INTO campus_memberships(campus_id,person_id,role,finance,admin_areas,active)
      VALUES(1,$1,'admin',0,'',1)
      ON CONFLICT(campus_id,person_id) DO UPDATE SET role='admin',active=1`, [approverPersonId]);
    await sql.unsafe("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES($1,'email',$2,$2)",
      [contactPointId, email]);
    await sql.unsafe(`INSERT INTO person_contact_links(id,person_id,contact_point_id,kind,source)
      VALUES($1,$2,$1,'email','merge-pg-execution')`, [contactPointId, approverPersonId]);
    await sql.unsafe(`INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method)
      VALUES($1,$2,'admin_review')`, [contactPointId, approverPersonId]);
    await sql.unsafe(`INSERT INTO identity_resolution_cases(
      id,campus_id,person_a_id,person_b_id,score,risk,state,version)
      VALUES($1,1,$2,$3,99,'normal','same_person',1)`,
    [resolutionCaseId, loserPersonId, canonicalPersonId]);
    await sql.unsafe(`INSERT INTO gift_results(id,person_id,top_gifts_json,recommended_json)
      VALUES($1,$2,'[]','[]')`, [giftResultId, loserPersonId]);

    const created = await createIdentityMergeOperation(db, {
      backend: 'supabase', caseId: resolutionCaseId, loserPersonId, canonicalPersonId,
      requestedByPersonId: approverPersonId, scope: { kind: 'global' }, now: new Date().toISOString(),
    });
    expect(created.preview).toEqual(expect.objectContaining({ inventoryCount: 1, expectedMutationCount: 1 }));
    await submitIdentityMergeForApproval(db, {
      operationId: created.operationId, expectedVersion: 1, actorPersonId: approverPersonId,
    });
    const authEnv = { IDENTITY_VERIFICATION_SECRET: 'p'.repeat(64) };
    const begun = await beginIdentityMergeApproval(db, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId, campusId: 1,
      requestContext: identityTrustedRequestContext(
        new Headers({ 'CF-Connecting-IP': '203.0.113.196' }), 'merge-pg-device',
      ),
    });
    await expect(completeIdentityMergeApproval(db, authEnv, {
      operationId: created.operationId, expectedVersion: 2, approverPersonId, campusId: 1,
      publicId: begun.delivery.publicId, code: begun.delivery.code,
    })).resolves.toEqual({ status: 'approved', operationId: created.operationId, version: 3 });
    const driftingDb = new DriftBeforeCoreMutationDb(db, giftResultId, driftPersonId);
    await expect(executeIdentityMerge(driftingDb, {
      backend: 'supabase', operationId: created.operationId, expectedVersion: 3, actorPersonId: approverPersonId,
    })).rejects.toThrow(/identity_merge_execute_stale/);
    expect(await db.prepare('SELECT person_id FROM gift_results WHERE id=?1')
      .bind(giftResultId).first<number>('person_id')).toBe(loserPersonId);
    expect(await db.prepare('SELECT state,version FROM person_merge_operations WHERE operation_id=?1')
      .bind(created.operationId).first()).toEqual({ state: 'approved', version: 3 });
    expect(await db.prepare('SELECT COUNT(*) n FROM person_merge_mutation_receipts WHERE operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(0);
    await expect(executeIdentityMerge(db, {
      backend: 'supabase', operationId: created.operationId, expectedVersion: 3, actorPersonId: approverPersonId,
    })).resolves.toEqual({ status: 'completed', operationId: created.operationId, version: 5, mutationCount: 1 });
    expect(await db.prepare('SELECT person_id FROM gift_results WHERE id=?1')
      .bind(giftResultId).first<number>('person_id')).toBe(canonicalPersonId);

    const rollback = await createIdentityMergeRollback(db, {
      operationId: created.operationId, expectedVersion: 5, requestedByPersonId: approverPersonId,
    });
    const rollbackBegun = await beginIdentityMergeRollbackApproval(db, authEnv, {
      rollbackId: rollback.rollbackId, expectedVersion: 2, approverPersonId, campusId: 1,
      requestContext: identityTrustedRequestContext(
        new Headers({ 'CF-Connecting-IP': '203.0.113.197' }), 'merge-pg-rollback-device',
      ),
    });
    await expect(completeIdentityMergeRollbackApproval(db, authEnv, {
      rollbackId: rollback.rollbackId, expectedVersion: 2, approverPersonId, campusId: 1,
      publicId: rollbackBegun.delivery.publicId, code: rollbackBegun.delivery.code,
    })).resolves.toEqual({ status: 'approved', rollbackId: rollback.rollbackId,
      operationId: created.operationId, version: 3 });

    await sql.unsafe('UPDATE gift_results SET person_id=$2 WHERE id=$1', [giftResultId, driftPersonId]);
    await expect(executeIdentityMergeRollback(db, {
      rollbackId: rollback.rollbackId, expectedVersion: 3, actorPersonId: approverPersonId,
    })).rejects.toThrow(/rollback_execute_stale/);
    expect(await db.prepare('SELECT state,version FROM person_merge_rollback_operations WHERE rollback_id=?1')
      .bind(rollback.rollbackId).first()).toEqual({ state: 'approved', version: 3 });
    expect(await db.prepare('SELECT COUNT(*) n FROM person_merge_rollback_receipts WHERE rollback_id=?1')
      .bind(rollback.rollbackId).first<number>('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) n FROM person_merge_redirects WHERE merge_operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(1);

    await sql.unsafe('UPDATE gift_results SET person_id=$2 WHERE id=$1', [giftResultId, canonicalPersonId]);
    await expect(executeIdentityMergeRollback(db, {
      rollbackId: rollback.rollbackId, expectedVersion: 3, actorPersonId: approverPersonId,
    })).resolves.toEqual({ status: 'completed', rollbackId: rollback.rollbackId,
      operationId: created.operationId, version: 5, revertedCount: 1, skippedSecurityCount: 0 });
    expect(await db.prepare('SELECT person_id FROM gift_results WHERE id=?1')
      .bind(giftResultId).first<number>('person_id')).toBe(loserPersonId);
    expect(await db.prepare('SELECT active FROM people WHERE id=?1')
      .bind(loserPersonId).first<number>('active')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) n FROM person_merge_redirects WHERE merge_operation_id=?1')
      .bind(created.operationId).first<number>('n')).toBe(0);
  });
});
