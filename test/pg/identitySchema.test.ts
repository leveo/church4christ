import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';
import { PgAdapter } from '../../src/lib/pgAdapter';

describe.skipIf(!hasPg)('member identity foundation (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
  });
  beforeEach(async () => {
    // contact_points is an independent root (not a descendant of people), so
    // clear both fixture roots before reusing explicit ids across tests.
    await sql.unsafe('TRUNCATE people, contact_points RESTART IDENTITY CASCADE');
    await sql.unsafe(`INSERT INTO people (id,display_name,email) VALUES
      (9901,'One','one@example.test'),(9902,'Two','two@example.test'),(9903,'Three','three@example.test');
      INSERT INTO contact_points (id,kind,normalized_value,display_value) VALUES
      (9901,'email','owner@example.test','owner@example.test'),
      (9902,'phone','+14155552671','+1 415 555 2671');
      INSERT INTO person_contact_links (person_id,contact_point_id,kind,source,is_primary) VALUES
      (9901,9901,'email','test',1),(9902,9901,'email','test',1);`);
  });
  afterAll(async () => { await sql?.end(); });

  it('permanently rejects retired legacy email-change state on both insert and update', async () => {
    await expect(sql.unsafe(`INSERT INTO tokens(person_id,token_hash,purpose,expires_at)
      VALUES(9901,repeat('a',64),'email_change','2099-01-01')`)).rejects.toThrow(/identity_legacy_email_change_retired/);
    await sql.unsafe(`INSERT INTO tokens(person_id,token_hash,purpose,expires_at)
      VALUES(9901,repeat('b',64),'login','2099-01-01')`);
    await expect(sql.unsafe("UPDATE tokens SET purpose='email_change' WHERE token_hash=repeat('b',64)"))
      .rejects.toThrow(/identity_legacy_email_change_retired/);
    await expect(sql.unsafe("INSERT INTO people(id,display_name,email,pending_email) VALUES(9999,'Legacy Insert','legacy-insert@example.test','attacker@example.test')"))
      .rejects.toThrow(/identity_legacy_pending_email_retired/);
    await expect(sql.unsafe("UPDATE people SET pending_email='legacy@example.test' WHERE id=9901"))
      .rejects.toThrow(/identity_legacy_pending_email_retired/);
  });

  it('installs the account-operation proof ledger and its PostgreSQL guard', async () => {
    const tables = await sql.unsafe(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('identity_account_operations','identity_account_review_cases','identity_account_proof_uses','identity_session_epoch_claims','identity_session_delivery_claims')
      ORDER BY table_name`);
    expect(tables.map((row) => row.table_name)).toEqual([
      'identity_account_operations',
      'identity_account_proof_uses',
      'identity_account_review_cases',
      'identity_session_delivery_claims',
      'identity_session_epoch_claims',
    ]);
    const triggers = await sql.unsafe(`SELECT tgname FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
      WHERE relation.relname IN ('identity_account_operations','identity_account_proof_uses','identity_session_epoch_claims','identity_session_delivery_claims')
        AND NOT trigger.tgisinternal ORDER BY tgname`);
    expect(triggers.map((row) => row.tgname)).toEqual([
      'identity_account_proof_guard',
      'identity_account_proof_uses_append_only_delete',
      'identity_account_proof_uses_append_only_update',
      'identity_contact_change_clean_guard',
      'identity_contact_change_completion_guard',
      'identity_session_delivery_claim_guard',
      'identity_session_delivery_claims_append_only_delete',
      'identity_session_delivery_claims_append_only_update',
      'identity_session_delivery_epoch_guard',
      'identity_session_epoch_claim_guard',
      'identity_session_epoch_claims_append_only_delete',
      'identity_session_epoch_claims_append_only_update',
      'identity_signup_create_clean_guard',
    ]);
    const constraints = await sql.unsafe(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid='identity_account_operations'::regclass AND contype='c'`);
    expect(constraints.map((row) => row.definition).join(' ')).toMatch(/octet_length\(requested_display_name\).*512/i);
  });

  it('pins the PostgreSQL recovery security key configuration append-only', async () => {
    await sql.unsafe(`INSERT INTO identity_recovery_key_config(singleton_id,key_id,algorithm_version,verification_tag)
      VALUES(1,'v1',1,repeat('f',64))`);
    await expect(sql.unsafe("UPDATE identity_recovery_key_config SET key_id='v2' WHERE singleton_id=1"))
      .rejects.toThrow(/identity_recovery_key_config_append_only/);
    await expect(sql.unsafe('DELETE FROM identity_recovery_key_config WHERE singleton_id=1'))
      .rejects.toThrow(/identity_recovery_key_config_append_only/);
  });

  it('enforces two-person recovery holds and append-only review evidence in PostgreSQL', async () => {
    await sql.unsafe("UPDATE people SET role='admin',super_admin=1 WHERE id IN (9902,9903)");
    await sql.unsafe(`UPDATE identity_person_canonical_keys key SET legacy_email_key=lower(person.email),
      normalized_name_key=lower(person.display_name),normalization_version=1,is_current=1,
      source_email=person.email,source_display_name=person.display_name
      FROM people person WHERE person.id=key.person_id`);
    await sql.unsafe("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(9901,9901,'admin_review')");
    await sql.unsafe("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(9904,'email','recovery-new@example.test','recovery-new@example.test')");
    await sql.unsafe(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,contact_point_id,code_hash,requester_bucket_hash,expires_at,consumed_at)
      VALUES(9904,'123e4567-e89b-42d3-a456-426614174931',1,'recovery',9904,repeat('a',64),repeat('b',64),'2035-01-01 00:10:00','2035-01-01 00:01:00')`);
    await sql.unsafe(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,target_person_id,state,result_case_id,expires_at,recovery_claim_hash)
      VALUES('123e4567-e89b-42d3-a456-426614174932',1,'recovery',9904,9901,'pending',NULL,'2035-01-01 00:10:00',repeat('c',64))`);
    await sql.unsafe(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(9904,'123e4567-e89b-42d3-a456-426614174932',9904,9901,'recovery_case')`);
    await sql.unsafe(`INSERT INTO identity_recovery_cases(id,campus_id,person_id,contact_point_id,state,risk,requester_bucket_hash,expires_at,source_operation_id,claimed_target_hash)
      VALUES(9904,1,9901,9904,'open','high',repeat('b',64),'2035-01-08 00:01:00','123e4567-e89b-42d3-a456-426614174932',repeat('c',64))`);
    await sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
      VALUES('123e4567-e89b-42d3-a456-426614174933',9904,'first_approval',9902,1,9901,1,0,0,'2035-01-01 00:02:00')`);
    await sql.unsafe(`INSERT INTO identity_recovery_owner_snapshots(case_id,contact_point_id,snapshot_role,expected_owner_person_id,expected_generation,created_at)
      VALUES(9904,9901,'target_auth',9901,0,'2035-01-01 00:02:00'),(9904,9904,'reachable',NULL,0,'2035-01-01 00:02:00')`);
    await sql.unsafe(`INSERT INTO identity_recovery_holds(case_id,first_decision_id,first_approver_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,reachable_contact_point_id,expected_reachable_owner_generation,
      veto_key_id,veto_token_hash,not_before_at,expires_at,created_at)
      VALUES(9904,'123e4567-e89b-42d3-a456-426614174933',9902,1,9901,1,0,9904,0,'v1',repeat('d',64),'2035-01-02 00:02:00','2035-01-08 00:01:00','2035-01-01 00:02:00')`);
    await sql.unsafe('UPDATE identity_recovery_cases SET reviewer_person_id=9902,version=2 WHERE id=9904');
    await sql.unsafe("INSERT INTO households(id,name) VALUES(9904,'Recovery PG Household')");
    await expect(sql.unsafe(`INSERT INTO household_contact_links(campus_id,household_id,contact_point_id,source)
      VALUES(1,9904,9904,'test')`)).rejects.toThrow(/identity_recovery_reachable_household_conflict/);
    await expect(sql.unsafe(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source)
      VALUES(9902,9904,'email','test')`)).rejects.toThrow(/identity_recovery_reachable_person_link_conflict/);
    await sql.unsafe(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,ended_at)
      VALUES(9902,9904,'email','test','2034-12-31 00:00:00')`);
    await expect(sql.unsafe(`UPDATE person_contact_links SET ended_at=NULL
      WHERE person_id=9902 AND contact_point_id=9904`)).rejects.toThrow(/identity_recovery_reachable_person_link_conflict/);
    const recoveryLinkGuard = await sql.unsafe(`SELECT procedure.prosrc AS source FROM pg_trigger trigger
      JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
      WHERE trigger.tgname='identity_recovery_person_contact_update_guard' AND NOT trigger.tgisinternal`);
    expect(String(recoveryLinkGuard[0]?.source).replace(/\s+/g, ' '))
      .toMatch(/pg_advisory_xact_lock\(732,OLD\.contact_point_id\).*pg_advisory_xact_lock\(732,NEW\.contact_point_id\)/i);
    for (const drift of [
      'campus_id=2',
      'person_id=9902',
      'contact_point_id=9901',
      'source_operation_id=NULL',
      "claimed_target_hash=repeat('e',64)",
      'source_version=2',
    ]) {
      await expect(sql.unsafe(`UPDATE identity_recovery_cases SET ${drift} WHERE id=9904`))
        .rejects.toThrow(/identity_recovery_binding_immutable/);
    }
    await expect(sql.unsafe('UPDATE identity_recovery_owner_snapshots SET expected_generation=1 WHERE case_id=9904'))
      .rejects.toThrow(/identity_recovery_owner_snapshots_append_only/);
    await expect(sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
      VALUES('123e4567-e89b-42d3-a456-426614174934',9904,'second_approval',9902,2,9901,1,0,0,'2035-01-02 00:02:00')`)).rejects.toThrow();
    await expect(sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
      VALUES('123e4567-e89b-42d3-a456-426614174935',9904,'second_approval',9903,2,9901,1,0,0,'2035-01-02 00:01:59')`)).rejects.toThrow(/identity_recovery_second_guard/);
    await expect(sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
      VALUES('123e4567-e89b-42d3-a456-426614174938',9904,'second_approval',9903,2,9901,1,0,0,'2035-01-08 00:01:00')`)).rejects.toThrow(/identity_recovery_second_guard/);
    await sql.unsafe("INSERT INTO people(id,display_name,email,role,super_admin) VALUES(9905,'Third','third-recovery@example.test','admin',1)");
    await sql.unsafe(`UPDATE identity_person_canonical_keys key SET legacy_email_key=lower(person.email),
      normalized_name_key=lower(person.display_name),normalization_version=1,is_current=1,
      source_email=person.email,source_display_name=person.display_name
      FROM people person WHERE person.id=key.person_id AND key.person_id=9905`);
    const contender = pgClient();
    try {
      const statement = (decisionId: string, actorId: number) => `INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
        expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
        VALUES('${decisionId}',9904,'second_approval',${actorId},2,9901,1,0,0,'2035-01-02 00:02:00')`;
      const settled = await Promise.allSettled([
        sql.unsafe(statement('123e4567-e89b-42d3-a456-426614174936', 9903)),
        contender.unsafe(statement('123e4567-e89b-42d3-a456-426614174937', 9905)),
      ]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    } finally {
      await contender.end();
    }
    await expect(sql.unsafe("UPDATE identity_recovery_holds SET expires_at='2036-01-01' WHERE case_id=9904"))
      .rejects.toThrow(/identity_recovery_holds_append_only/);
    await sql.unsafe(`INSERT INTO identity_recovery_notification_outbox(case_id,category,contact_point_id,recipient_hash,locale)
      VALUES(9904,'completed_old_contact',9901,repeat('e',64),'en')`);
    await expect(sql.unsafe("UPDATE identity_recovery_notification_outbox SET recipient_hash=repeat('f',64) WHERE case_id=9904"))
      .rejects.toThrow(/identity_recovery_notification_transition_guard/);
    await expect(sql.unsafe('UPDATE identity_recovery_notification_receipts SET attempt=1'))
      .rejects.toThrow(/identity_recovery_notification_receipts_append_only/);
  });

  it('rejects a PostgreSQL recovery approval for a canonically equivalent Unicode legacy email', async () => {
    const legacyNfd = 'legacy-e\u0301-pg@example.test';
    const reachableNfc = legacyNfd.normalize('NFC');
    await sql.unsafe("UPDATE people SET role='admin',super_admin=1 WHERE id IN (9902,9903)");
    await sql.unsafe("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(9901,9901,'admin_review')");
    await sql`INSERT INTO people(id,display_name,email) VALUES(9913,'Unicode Legacy Collision',${legacyNfd})`;
    await sql`INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(9913,'email',${reachableNfc},${reachableNfc})`;
    await sql.unsafe(`UPDATE identity_person_canonical_keys key SET
      legacy_email_key=person.email,normalized_name_key=lower(person.display_name),normalization_version=1,is_current=1,
      source_email=person.email,source_display_name=person.display_name
      FROM people person WHERE person.id=key.person_id`);
    await sql`UPDATE identity_person_canonical_keys SET legacy_email_key=${reachableNfc} WHERE person_id=9913`;
    await sql.unsafe(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,contact_point_id,code_hash,requester_bucket_hash,expires_at,consumed_at)
      VALUES(9913,'423e4567-e89b-42d3-a456-426614174931',1,'recovery',9913,repeat('a',64),repeat('b',64),'2035-01-01 00:10:00','2035-01-01 00:01:00')`);
    await sql.unsafe(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,target_person_id,state,expires_at,recovery_claim_hash)
      VALUES('423e4567-e89b-42d3-a456-426614174932',1,'recovery',9913,9901,'pending','2035-01-01 00:10:00',repeat('c',64))`);
    await sql.unsafe(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(9913,'423e4567-e89b-42d3-a456-426614174932',9913,9901,'recovery_case')`);
    await sql.unsafe(`INSERT INTO identity_recovery_cases(id,campus_id,person_id,contact_point_id,state,risk,requester_bucket_hash,expires_at,source_operation_id,claimed_target_hash)
      VALUES(9913,1,9901,9913,'open','high',repeat('b',64),'2035-01-08 00:01:00','423e4567-e89b-42d3-a456-426614174932',repeat('c',64))`);
    await sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
      VALUES('423e4567-e89b-42d3-a456-426614174933',9913,'first_approval',9902,1,9901,1,0,0,'2035-01-01 00:02:00')`);
    await sql.unsafe(`INSERT INTO identity_recovery_owner_snapshots(case_id,contact_point_id,snapshot_role,expected_owner_person_id,expected_generation,created_at)
      VALUES(9913,9901,'target_auth',9901,0,'2035-01-01 00:02:00'),(9913,9913,'reachable',NULL,0,'2035-01-01 00:02:00')`);
    await sql.unsafe(`INSERT INTO identity_recovery_holds(case_id,first_decision_id,first_approver_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,reachable_contact_point_id,expected_reachable_owner_generation,
      veto_key_id,veto_token_hash,not_before_at,expires_at,created_at)
      VALUES(9913,'423e4567-e89b-42d3-a456-426614174933',9902,1,9901,1,0,9913,0,'v1',repeat('d',64),'2035-01-02 00:02:00','2035-01-08 00:01:00','2035-01-01 00:02:00')`);
    await sql.unsafe('UPDATE identity_recovery_cases SET reviewer_person_id=9902,version=2 WHERE id=9913');

    await expect(sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
      VALUES('423e4567-e89b-42d3-a456-426614174934',9913,'second_approval',9903,2,9901,1,0,0,'2035-01-02 00:02:00')`))
      .rejects.toThrow(/identity_recovery_second_guard/);
  });

  it('serializes a PostgreSQL recovery approval against a direct active person-link insert', async () => {
    await sql.unsafe("UPDATE people SET role='admin',super_admin=1 WHERE id IN (9902,9903)");
    await sql.unsafe(`UPDATE identity_person_canonical_keys key SET legacy_email_key=lower(person.email),
      normalized_name_key=lower(person.display_name),normalization_version=1,is_current=1,
      source_email=person.email,source_display_name=person.display_name
      FROM people person WHERE person.id=key.person_id`);
    await sql.unsafe("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(9901,9901,'admin_review')");
    await sql.unsafe("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(9910,'email','race-recovery@example.test','race-recovery@example.test')");
    await sql.unsafe(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,contact_point_id,code_hash,requester_bucket_hash,expires_at,consumed_at)
      VALUES(9910,'223e4567-e89b-42d3-a456-426614174931',1,'recovery',9910,repeat('a',64),repeat('b',64),'2035-01-01 00:10:00','2035-01-01 00:01:00')`);
    await sql.unsafe(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,target_person_id,state,expires_at,recovery_claim_hash)
      VALUES('223e4567-e89b-42d3-a456-426614174932',1,'recovery',9910,9901,'pending','2035-01-01 00:10:00',repeat('c',64))`);
    await sql.unsafe(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(9910,'223e4567-e89b-42d3-a456-426614174932',9910,9901,'recovery_case')`);
    await sql.unsafe(`INSERT INTO identity_recovery_cases(id,campus_id,person_id,contact_point_id,state,risk,requester_bucket_hash,expires_at,source_operation_id,claimed_target_hash)
      VALUES(9910,1,9901,9910,'open','high',repeat('b',64),'2035-01-08 00:01:00','223e4567-e89b-42d3-a456-426614174932',repeat('c',64))`);
    await sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
      VALUES('223e4567-e89b-42d3-a456-426614174933',9910,'first_approval',9902,1,9901,1,0,0,'2035-01-01 00:02:00')`);
    await sql.unsafe(`INSERT INTO identity_recovery_owner_snapshots(case_id,contact_point_id,snapshot_role,expected_owner_person_id,expected_generation,created_at)
      VALUES(9910,9901,'target_auth',9901,0,'2035-01-01 00:02:00'),(9910,9910,'reachable',NULL,0,'2035-01-01 00:02:00')`);
    await sql.unsafe(`INSERT INTO identity_recovery_holds(case_id,first_decision_id,first_approver_person_id,expected_case_version,expected_person_id,
      expected_person_identity_version,expected_person_session_epoch,reachable_contact_point_id,expected_reachable_owner_generation,
      veto_key_id,veto_token_hash,not_before_at,expires_at,created_at)
      VALUES(9910,'223e4567-e89b-42d3-a456-426614174933',9902,1,9901,1,0,9910,0,'v1',repeat('d',64),'2035-01-02 00:02:00','2035-01-08 00:01:00','2035-01-01 00:02:00')`);
    await sql.unsafe('UPDATE identity_recovery_cases SET reviewer_person_id=9902,version=2 WHERE id=9910');
    const contender = pgClient();
    try {
      const settled = await Promise.allSettled([
        sql.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
          expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
          VALUES('223e4567-e89b-42d3-a456-426614174934',9910,'second_approval',9903,2,9901,1,0,0,'2035-01-02 00:02:00')`),
        contender.unsafe("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(9902,9910,'email','race')"),
      ]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const decisionCount = (await sql.unsafe("SELECT count(*)::int n FROM identity_recovery_decisions WHERE case_id=9910 AND decision='second_approval'"))[0].n;
      const linkCount = (await sql.unsafe('SELECT count(*)::int n FROM person_contact_links WHERE contact_point_id=9910 AND ended_at IS NULL'))[0].n;
      expect(decisionCount + linkCount).toBe(1);
    } finally {
      await contender.end();
    }
    await sql.unsafe("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(9911,'email','ordinary-link@example.test','ordinary-link@example.test')");
    await expect(sql.unsafe("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(9903,9911,'email','ordinary')"))
      .resolves.toBeTruthy();
  });

  it('serializes first approval, owner recheck, and hold creation against a new reachable person link', async () => {
    await sql.unsafe("UPDATE people SET role='admin',super_admin=1 WHERE id=9902");
    await sql.unsafe("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(9901,9901,'admin_review')");
    await sql.unsafe("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(9912,'email','first-race@example.test','first-race@example.test')");
    await sql.unsafe(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,contact_point_id,code_hash,requester_bucket_hash,expires_at,consumed_at)
      VALUES(9912,'323e4567-e89b-42d3-a456-426614174931',1,'recovery',9912,repeat('a',64),repeat('b',64),'2035-01-01 00:10:00','2035-01-01 00:01:00')`);
    await sql.unsafe(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,target_person_id,state,expires_at,recovery_claim_hash)
      VALUES('323e4567-e89b-42d3-a456-426614174932',1,'recovery',9912,9901,'pending','2035-01-01 00:10:00',repeat('c',64))`);
    await sql.unsafe(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
      VALUES(9912,'323e4567-e89b-42d3-a456-426614174932',9912,9901,'recovery_case')`);
    await sql.unsafe(`INSERT INTO identity_recovery_cases(id,campus_id,person_id,contact_point_id,state,risk,requester_bucket_hash,expires_at,source_operation_id,claimed_target_hash)
      VALUES(9912,1,9901,9912,'open','high',repeat('b',64),'2035-01-08 00:01:00','323e4567-e89b-42d3-a456-426614174932',repeat('c',64))`);
    const contender = pgClient();
    try {
      const settled = await Promise.allSettled([
        sql.begin(async (tx) => {
          await tx.unsafe(`INSERT INTO identity_recovery_decisions(decision_id,case_id,decision,actor_person_id,expected_case_version,expected_person_id,
            expected_person_identity_version,expected_person_session_epoch,expected_reachable_owner_generation,created_at)
            VALUES('323e4567-e89b-42d3-a456-426614174933',9912,'first_approval',9902,1,9901,1,0,0,'2035-01-01 00:02:00')`);
          await tx.unsafe(`INSERT INTO identity_recovery_owner_snapshots(case_id,contact_point_id,snapshot_role,expected_owner_person_id,expected_generation,created_at)
            VALUES(9912,9901,'target_auth',9901,0,'2035-01-01 00:02:00'),(9912,9912,'reachable',NULL,0,'2035-01-01 00:02:00')`);
          await tx.unsafe(`INSERT INTO identity_recovery_holds(case_id,first_decision_id,first_approver_person_id,expected_case_version,expected_person_id,
            expected_person_identity_version,expected_person_session_epoch,reachable_contact_point_id,expected_reachable_owner_generation,
            veto_key_id,veto_token_hash,not_before_at,expires_at,created_at)
            VALUES(9912,'323e4567-e89b-42d3-a456-426614174933',9902,1,9901,1,0,9912,0,'v1',repeat('d',64),'2035-01-02 00:02:00','2035-01-08 00:01:00','2035-01-01 00:02:00')`);
        }),
        contender.unsafe("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(9903,9912,'email','first-race')"),
      ]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const decisionCount = (await sql.unsafe("SELECT count(*)::int n FROM identity_recovery_decisions WHERE case_id=9912 AND decision='first_approval'"))[0].n;
      const holdCount = (await sql.unsafe('SELECT count(*)::int n FROM identity_recovery_holds WHERE case_id=9912'))[0].n;
      const linkCount = (await sql.unsafe('SELECT count(*)::int n FROM person_contact_links WHERE contact_point_id=9912 AND ended_at IS NULL'))[0].n;
      expect(decisionCount).toBe(holdCount);
      expect(holdCount + linkCount).toBe(1);
    } finally {
      await contender.end();
    }
  });

  it('rolls back the PostgreSQL account batch when the expected session epoch is stale', async () => {
    const db = new PgAdapter(sql);
    await sql.unsafe("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(9903,'email','new-owner@example.test','new-owner@example.test')");
    await sql.unsafe(`INSERT INTO identity_challenges(id,public_id,campus_id,purpose,person_id,contact_point_id,code_hash,requester_bucket_hash,expires_at,consumed_at)
      VALUES(9903,'123e4567-e89b-42d3-a456-426614174903',1,'contact_change',9901,9903,repeat('a',64),repeat('b',64),'2099-01-01','2030-01-01')`);
    await sql.unsafe(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,target_person_id,prior_contact_point_id,expected_session_epoch,expires_at)
      VALUES('123e4567-e89b-42d3-a456-426614174904',1,'contact_change',9903,9901,9901,0,'2099-01-01')`);
    await sql.unsafe('UPDATE people SET session_epoch=1 WHERE id=9901');
    await sql.unsafe(`UPDATE identity_person_canonical_keys
      SET normalization_version=1,is_current=1,legacy_email_key='fixture-'||person_id||'@example.test',normalized_name_key='fixture-'||person_id`);
    await expect(db.batch([
      db.prepare(`INSERT INTO identity_account_proof_uses(challenge_id,operation_id,contact_point_id,person_id,proof_category)
        VALUES(9903,'123e4567-e89b-42d3-a456-426614174904',9903,9901,'contact_change')`),
      db.prepare(`INSERT INTO identity_session_epoch_claims(operation_id,person_id,expected_epoch,resulting_epoch)
        VALUES('123e4567-e89b-42d3-a456-426614174904',9901,0,1)`),
      db.prepare("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(9901,9903,'email','test')"),
      db.prepare("UPDATE identity_account_operations SET state='completed',result_person_id=9901 WHERE operation_id='123e4567-e89b-42d3-a456-426614174904'"),
    ])).rejects.toThrow(/identity_contact_change_epoch_conflict/);
    expect((await sql.unsafe("SELECT count(*)::int n FROM identity_account_proof_uses WHERE operation_id='123e4567-e89b-42d3-a456-426614174904'"))[0].n).toBe(0);
    expect((await sql.unsafe('SELECT count(*)::int n FROM person_contact_links WHERE person_id=9901 AND contact_point_id=9903'))[0].n).toBe(0);
    expect((await sql.unsafe("SELECT state FROM identity_account_operations WHERE operation_id='123e4567-e89b-42d3-a456-426614174904'"))[0].state).toBe('pending');
  });

  it('enforces contact kind and exactly one legal resolution-case shape', async () => {
    await expect(sql.unsafe("INSERT INTO person_contact_links (person_id,contact_point_id,kind,source) VALUES (9903,9901,'phone','test')"))
      .rejects.toThrow();
    await sql.unsafe("INSERT INTO identity_observations (id,campus_id,source,source_key,status) VALUES (9901,1,'import','pg-observation','review')");
    await sql.unsafe(`INSERT INTO identity_resolution_cases (campus_id,person_a_id,person_b_id,score)
      VALUES (1,9901,9902,50)`);
    await sql.unsafe(`INSERT INTO identity_resolution_cases (campus_id,observation_id,candidate_person_id,score)
      VALUES (1,9901,9903,50)`);
    await sql.unsafe(`INSERT INTO identity_resolution_cases (campus_id,observation_id,candidate_person_id,score)
      VALUES (1,9901,9902,51)`);
    await expect(sql.unsafe(`INSERT INTO identity_resolution_cases (campus_id,observation_id,score)
      VALUES (1,9901,50)`)).rejects.toThrow();
    await expect(sql.unsafe(`INSERT INTO identity_resolution_cases (campus_id,observation_id,candidate_person_id,score)
      VALUES (1,9901,9903,55)`)).rejects.toThrow();
  });

  it('enforces the same four owner/link trigger identities and their active-link boundary', async () => {
    const triggers = await sql.unsafe(`SELECT tgname,pg_get_triggerdef(trigger.oid) AS definition,procedure.prosrc AS source FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid=trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      JOIN pg_proc procedure ON procedure.oid=trigger.tgfoid
      WHERE namespace.nspname='public' AND NOT trigger.tgisinternal
        AND (tgname LIKE 'verified_contact_owner_requires_active_link_%' OR tgname LIKE 'person_contact_link_%') ORDER BY tgname`);
    expect(triggers.map((row) => row.tgname)).toEqual([
      'person_contact_link_identity_immutable',
      'person_contact_link_owner_cannot_delete',
      'person_contact_link_owner_cannot_end',
      'verified_contact_owner_requires_active_link_insert',
      'verified_contact_owner_requires_active_link_update',
    ]);
    expect(triggers.map((row) => String(row.definition).replace(/\s+/g, ' ').trim())).toEqual([
      'CREATE TRIGGER person_contact_link_identity_immutable BEFORE UPDATE OF person_id, contact_point_id ON public.person_contact_links FOR EACH ROW EXECUTE FUNCTION person_contact_link_identity_immutable()',
      'CREATE TRIGGER person_contact_link_owner_cannot_delete BEFORE DELETE ON public.person_contact_links FOR EACH ROW EXECUTE FUNCTION person_contact_link_owner_cannot_delete()',
      'CREATE TRIGGER person_contact_link_owner_cannot_end BEFORE UPDATE OF ended_at ON public.person_contact_links FOR EACH ROW EXECUTE FUNCTION person_contact_link_owner_cannot_end()',
      'CREATE TRIGGER verified_contact_owner_requires_active_link_insert BEFORE INSERT ON public.verified_contact_owners FOR EACH ROW EXECUTE FUNCTION verified_contact_owner_requires_active_link_insert()',
      'CREATE TRIGGER verified_contact_owner_requires_active_link_update BEFORE UPDATE OF person_id, contact_point_id ON public.verified_contact_owners FOR EACH ROW EXECUTE FUNCTION verified_contact_owner_requires_active_link_update()',
    ]);
    const sourceByName = new Map(triggers.map((row) => [String(row.tgname), String(row.source).replace(/\s+/g, ' ')]));
    expect(sourceByName.get('person_contact_link_owner_cannot_end'))
      .toMatch(/if old\.ended_at is null and new\.ended_at is not null and exists \( select 1 from verified_contact_owners/i);
    expect(sourceByName.get('person_contact_link_owner_cannot_delete'))
      .toMatch(/if old\.ended_at is null and exists \(\s*select 1 from verified_contact_owners/i);
    await expect(sql.unsafe("INSERT INTO verified_contact_owners (contact_point_id,person_id,verification_method) VALUES (9902,9902,'admin_review')"))
      .rejects.toThrow(/verified_contact_owner_requires_active_link/);
    await sql.unsafe("INSERT INTO verified_contact_owners (contact_point_id,person_id,verification_method) VALUES (9901,9901,'admin_review')");
    await expect(sql.unsafe("UPDATE person_contact_links SET ended_at=datetime('now') WHERE person_id=9901 AND contact_point_id=9901"))
      .rejects.toThrow(/verified_contact_owner_requires_active_link/);
    await expect(sql.unsafe('UPDATE person_contact_links SET person_id=9902 WHERE person_id=9901 AND contact_point_id=9901'))
      .rejects.toThrow(/person_contact_link_identity_immutable/);
  });

  it('keeps a step-up OTP unconsumed when campus membership is revoked', async () => {
    await sql.unsafe("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(9901,9901,'admin_review')");
    await sql.unsafe(`INSERT INTO identity_challenges(public_id,campus_id,purpose,person_id,contact_point_id,code_hash,requester_bucket_hash,expires_at)
      VALUES('123e4567-e89b-42d3-a456-426614174733',1,'step_up',9901,9901,repeat('a',64),repeat('b',64),'2099-01-01 00:00:00')`);
    await sql.unsafe('UPDATE campus_memberships SET active=0 WHERE campus_id=1 AND person_id=9901');
    await expect(sql.unsafe(`UPDATE identity_challenges SET consumed_at='2030-01-01 00:01:00'
      WHERE public_id='123e4567-e89b-42d3-a456-426614174733'`)).rejects.toThrow(
      /identity_(?:step_up_target_invalid|credential_epoch_stale)/,
    );
    const rows = await sql.unsafe("SELECT consumed_at FROM identity_challenges WHERE public_id='123e4567-e89b-42d3-a456-426614174733'");
    expect(rows[0].consumed_at).toBeNull();
  });

  it('rejects invalid identity JSON and preserves only one-hop merge redirects', async () => {
    const hash = 'a'.repeat(64);
    await expect(sql.unsafe(`INSERT INTO identity_challenges
      (campus_id,purpose,public_id,token_hash,requester_bucket_hash,expires_at,context_json)
      VALUES (1,'login','123e4567-e89b-12d3-a456-426614174001','${hash}','${hash}','2099-01-01','[]')`)).rejects.toThrow();
    await expect(sql.unsafe("INSERT INTO identity_audit_events (campus_id,event_type,metadata_json) VALUES (1,'test','[]')")).rejects.toThrow();
    await sql.unsafe('INSERT INTO person_merge_redirects (loser_person_id,canonical_person_id) VALUES (9901,9902)');
    await expect(sql.unsafe('INSERT INTO person_merge_redirects (loser_person_id,canonical_person_id) VALUES (9902,9903)')).rejects.toThrow();
  });

  it('rejects C0 and DEL controls in stored identity text carriers', async () => {
    await expect(sql.unsafe("INSERT INTO contact_points(kind,normalized_value,display_value) VALUES('email','control@example.test','bad'||chr(10))")).rejects.toThrow();
    await expect(sql.unsafe("INSERT INTO identity_observations(campus_id,source,source_key,normalized_name) VALUES(1,'signup','bad'||chr(127),'member')")).rejects.toThrow();
    await expect(sql.unsafe("INSERT INTO person_external_identities(person_id,provider,organization_id,external_person_id) VALUES(9901,'bad'||chr(1),'org','person')")).rejects.toThrow();
  });

  it('keeps proof use, mutation, ownership event, and audit ledgers append-only', async () => {
    await sql.unsafe("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(9901,9901,'admin_review')");
    await sql.unsafe("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(9902,9902,'phone','test')");
    await sql.unsafe("INSERT INTO identity_challenges(public_id,campus_id,purpose,person_id,contact_point_id,code_hash,requester_bucket_hash,expires_at,consumed_at) VALUES('123e4567-e89b-12d3-a456-426614174099',1,'claim',9902,9902,repeat('a',64),repeat('b',64),'2099-01-01','2030-01-01')");
    await sql.unsafe("INSERT INTO identity_challenge_proof_uses(challenge_id,contact_point_id,person_id,purpose,proof_category) SELECT id,9902,9902,'claim','email_challenge' FROM identity_challenges WHERE public_id='123e4567-e89b-12d3-a456-426614174099'");
    await sql.unsafe("INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation) VALUES(9901,1,9901,NULL,'revoke')");
    await sql.unsafe("INSERT INTO contact_ownership_events(contact_point_id,previous_person_id,event_type) VALUES(9901,9901,'revoked')");
    await sql.unsafe("INSERT INTO identity_audit_events(campus_id,event_type,contact_point_id) VALUES(1,'proof',9901)");
    for (const table of ['identity_challenge_proof_uses', 'contact_owner_mutation_claims', 'contact_ownership_events', 'identity_audit_events']) {
      await expect(sql.unsafe(`UPDATE ${table} SET created_at=created_at`)).rejects.toThrow(/append_only/);
      await expect(sql.unsafe(`DELETE FROM ${table}`)).rejects.toThrow(/append_only/);
    }
  });

  it('serializes opposing merge redirects into at most one one-hop edge', async () => {
    const contender = pgClient();
    try {
      let release!: () => void;
      const start = new Promise<void>((resolve) => { release = resolve; });
      const left = (async () => { await start; return sql.unsafe('INSERT INTO person_merge_redirects (loser_person_id,canonical_person_id) VALUES (9901,9902)'); })();
      const right = (async () => { await start; return contender.unsafe('INSERT INTO person_merge_redirects (loser_person_id,canonical_person_id) VALUES (9902,9901)'); })();
      release();
      const settled = await Promise.allSettled([left, right]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rows = await sql.unsafe('SELECT loser_person_id,canonical_person_id FROM person_merge_redirects');
      expect(rows).toHaveLength(1);
    } finally {
      await contender.end();
    }
  });

  it.each([
    ['end', "UPDATE person_contact_links SET ended_at=datetime('now') WHERE person_id=9901 AND contact_point_id=9901"],
    ['delete', 'DELETE FROM person_contact_links WHERE person_id=9901 AND contact_point_id=9901'],
  ])('serializes owner insert against active-link %s with one safe final state', async (_operation, mutation) => {
    const contender = pgClient();
    try {
      let release!: () => void;
      const start = new Promise<void>((resolve) => { release = resolve; });
      const ownerWrite = (async () => {
        await start;
        return sql.unsafe("INSERT INTO verified_contact_owners (contact_point_id,person_id,verification_method) VALUES (9901,9901,'admin_review')");
      })();
      const linkWrite = (async () => {
        await start;
        return contender.unsafe(mutation);
      })();
      release();
      const settled = await Promise.allSettled([ownerWrite, linkWrite]);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const owner = (await sql.unsafe('SELECT person_id,contact_point_id FROM verified_contact_owners WHERE contact_point_id=9901'))[0];
      if (owner) {
        const active = await sql.unsafe(`SELECT 1 FROM person_contact_links
          WHERE person_id=$1 AND contact_point_id=$2 AND ended_at IS NULL`, [owner.person_id, owner.contact_point_id]);
        expect(active).toHaveLength(1);
      }
    } finally {
      await contender.end();
    }
  });
});
