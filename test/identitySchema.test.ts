import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const IDENTITY_TABLES = [
  'contact_points',
  'person_contact_links',
  'household_contact_links',
  'verified_contact_owners',
  'contact_owner_mutation_claims',
  'contact_ownership_events',
  'identity_challenges',
  'identity_rate_limits',
  'identity_otp_failure_claims',
  'identity_person_canonical_keys',
  'identity_observations',
  'identity_resolution_cases',
  'person_merge_redirects',
  'person_merge_events',
  'identity_recovery_cases',
  'identity_recovery_decisions',
  'identity_recovery_holds',
  'identity_recovery_owner_snapshots',
  'identity_recovery_notification_outbox',
  'identity_recovery_notification_receipts',
  'identity_recovery_key_config',
  'person_external_identities',
  'external_person_mergers',
  'identity_provider_sync_state',
  'identity_audit_events',
  'identity_account_operations',
  'identity_account_review_cases',
  'identity_account_proof_uses',
  'identity_session_epoch_claims',
  'identity_session_delivery_claims',
] as const;

describe('member identity foundation schema (D1)', () => {
  it('adds the additive identity relations and people compatibility columns', async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    const names = new Set(tables.results.map(({ name }) => name));
    for (const table of IDENTITY_TABLES) expect(names.has(table), table).toBe(true);

    const people = await env.DB.prepare('PRAGMA table_info(people)')
      .all<{ name: string; notnull: number; dflt_value: string | null }>();
    expect(people.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'identity_state', notnull: 1, dflt_value: "'active'" }),
      expect.objectContaining({ name: 'identity_version', notnull: 1, dflt_value: '1' }),
      expect.objectContaining({ name: 'merged_into_person_id' }),
      expect.objectContaining({ name: 'auth_disabled_at' }),
      expect.objectContaining({ name: 'provisional_source' }),
      expect.objectContaining({ name: 'email', notnull: 1 }),
    ]));
  });

  it('enforces globally unique normalized contacts and active-primary link boundaries', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88001, 'Identity One', 'identity-one@example.test')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88002, 'Identity Two', 'identity-two@example.test')"),
      env.DB.prepare("INSERT INTO contact_points (id, kind, normalized_value, display_value) VALUES (88001, 'email', 'one@example.test', 'one@example.test')"),
      env.DB.prepare("INSERT INTO contact_points (id, kind, normalized_value, display_value) VALUES (88002, 'email', 'two@example.test', 'two@example.test')"),
      env.DB.prepare("INSERT INTO person_contact_links (person_id, contact_point_id, kind, source, is_primary) VALUES (88001, 88001, 'email', 'legacy', 1)"),
    ]);
    await expect(env.DB.prepare("INSERT INTO contact_points (kind, normalized_value, display_value) VALUES ('email', 'one@example.test', 'copy@example.test')").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO person_contact_links (person_id, contact_point_id, kind, source, is_primary) VALUES (88001, 88002, 'email', 'legacy', 1)").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO person_contact_links (person_id, contact_point_id, kind, source) VALUES (88002, 88001, 'phone', 'legacy')").run()).rejects.toThrow();
  });

  it('keeps verified ownership explicit and representable by an active contact link', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88101, 'Backfill', 'Backfill@Example.Test')"),
      env.DB.prepare("INSERT INTO contact_points (id, kind, normalized_value, display_value) VALUES (88101, 'email', 'backfill@example.test', 'Backfill@Example.Test')"),
      env.DB.prepare("INSERT INTO person_contact_links (person_id, contact_point_id, kind, source, is_primary) VALUES (88101, 88101, 'email', 'legacy', 1)"),
      env.DB.prepare("INSERT INTO verified_contact_owners (contact_point_id, person_id, verification_method) VALUES (88101, 88101, 'legacy_unique')"),
    ]);
    expect(await env.DB.prepare("SELECT person_id FROM verified_contact_owners owner JOIN contact_points point ON point.id=owner.contact_point_id WHERE point.normalized_value='backfill@example.test'").first('person_id')).toBe(88101);
    await expect(env.DB.prepare("INSERT INTO verified_contact_owners (contact_point_id, person_id, verification_method) VALUES (88002, 88101, 'admin_review')").run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE person_contact_links SET ended_at=datetime(\'now\') WHERE contact_point_id=88101').run()).rejects.toThrow();
  });

  it('makes an active contact link identity immutable instead of permitting reassignment', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88111, 'Link One', 'link-one@example.test')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88112, 'Link Two', 'link-two@example.test')"),
      env.DB.prepare("INSERT INTO contact_points (id, kind, normalized_value, display_value) VALUES (88111, 'email', 'link@example.test', 'link@example.test')"),
      env.DB.prepare("INSERT INTO contact_points (id, kind, normalized_value, display_value) VALUES (88112, 'email', 'link-two@example.test', 'link-two@example.test')"),
      env.DB.prepare("INSERT INTO person_contact_links (id, person_id, contact_point_id, kind, source, is_primary) VALUES (88111, 88111, 88111, 'email', 'test', 1)"),
    ]);
    await expect(env.DB.prepare('UPDATE person_contact_links SET person_id=88112 WHERE id=88111').run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE person_contact_links SET contact_point_id=88112 WHERE id=88111').run()).rejects.toThrow();
  });

  it('enforces one-hop merge redirects and rejects direct cycles on insert or update', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88121, 'Redirect A', 'redirect-a@example.test')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88122, 'Redirect B', 'redirect-b@example.test')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88123, 'Redirect C', 'redirect-c@example.test')"),
      env.DB.prepare('INSERT INTO person_merge_redirects (loser_person_id, canonical_person_id) VALUES (88121, 88122)'),
    ]);
    await expect(env.DB.prepare('INSERT INTO person_merge_redirects (loser_person_id, canonical_person_id) VALUES (88122, 88123)').run()).rejects.toThrow();
    await expect(env.DB.prepare('INSERT INTO person_merge_redirects (loser_person_id, canonical_person_id) VALUES (88123, 88121)').run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE person_merge_redirects SET canonical_person_id=88121 WHERE loser_person_id=88121').run()).rejects.toThrow();
  });

  it('rejects non-object, oversized, and NUL-bearing identity JSON carriers', async () => {
    const hash = 'a'.repeat(64);
    const tooLarge = JSON.stringify({ value: 'x'.repeat(4_089) });
    await expect(env.DB.prepare(`INSERT INTO identity_challenges
      (campus_id,purpose,public_id,token_hash,requester_bucket_hash,expires_at,context_json)
      VALUES (1,'login','123e4567-e89b-12d3-a456-426614174001','${hash}','${hash}','2099-01-01 00:00:00','[]')`).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO identity_challenges
      (campus_id,purpose,public_id,token_hash,requester_bucket_hash,expires_at,context_json)
      VALUES (1,'login','123e4567-e89b-12d3-a456-426614174002','${hash}','${hash}','2099-01-01 00:00:00',?)`).bind(tooLarge).run()).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT INTO identity_challenges
      (campus_id,purpose,public_id,token_hash,requester_bucket_hash,expires_at,context_json)
      VALUES (1,'login','123e4567-e89b-12d3-a456-426614174003','${hash}','${hash}','2099-01-01 00:00:00','{"value":"' || char(0) || '"}')`).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO identity_audit_events (campus_id,event_type,metadata_json) VALUES (1,'test','[]')").run()).rejects.toThrow();
  });

  it('rejects C0 and DEL controls in stored identity text carriers', async () => {
    await expect(env.DB.prepare("INSERT INTO contact_points(kind,normalized_value,display_value) VALUES('email','control@example.test','bad'||char(10))").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO identity_observations(campus_id,source,source_key,normalized_name) VALUES(1,'signup','bad'||char(127),'member')").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO person_external_identities(person_id,provider,organization_id,external_person_id) VALUES(1,'bad'||char(1),'org','person')").run()).rejects.toThrow();
  });

  it('requires campus partitions for all identity workflows and bounds their enumerations', async () => {
    for (const table of ['household_contact_links', 'identity_challenges', 'identity_rate_limits', 'identity_otp_failure_claims', 'identity_observations', 'identity_resolution_cases', 'identity_recovery_cases', 'identity_audit_events', 'identity_account_operations', 'identity_account_review_cases']) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string; notnull: number; dflt_value: string | null }>();
      expect(columns.results.find((column) => column.name === 'campus_id'), table)
        .toMatchObject({ name: 'campus_id', notnull: 1, dflt_value: '1' });
    }
    await expect(env.DB.prepare(`INSERT INTO identity_challenges
      (campus_id, purpose, public_id, token_hash, requester_bucket_hash, expires_at)
      VALUES (1, 'bad', '123e4567-e89b-12d3-a456-426614174004', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '2099-01-01 00:00:00')`).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO identity_observations (campus_id, source, source_key, status) VALUES (1, 'bad', 'source-key', 'provisional')").run()).rejects.toThrow();
  });

  it('uses an opaque lowercase UUID-shaped public ID for challenge lookup', async () => {
    const columns = await env.DB.prepare('PRAGMA table_info(identity_challenges)').all<{ name: string; notnull: number }>();
    expect(columns.results).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'public_id', notnull: 1 })]));
    const hash = 'c'.repeat(64);
    await expect(env.DB.prepare(`INSERT INTO identity_challenges
      (campus_id,purpose,public_id,token_hash,requester_bucket_hash,expires_at)
      VALUES (1,'login','NOT-A-UUID','${hash}','${hash}','2099-01-01 00:00:00')`).run()).rejects.toThrow();
    await env.DB.prepare(`INSERT INTO identity_challenges
      (campus_id,purpose,public_id,token_hash,requester_bucket_hash,expires_at)
      VALUES (1,'login','123e4567-e89b-12d3-a456-426614174000','${hash}','${hash}','2099-01-01 00:00:00')`).run();
    await expect(env.DB.prepare(`INSERT INTO identity_challenges
      (campus_id,purpose,public_id,token_hash,requester_bucket_hash,expires_at)
      VALUES (1,'login','123e4567-e89b-12d3-a456-426614174000','${hash}','${hash}','2099-01-01 00:00:00')`).run()).rejects.toThrow();
  });

  it('bounds account-operation names by UTF-8 bytes rather than code points', async () => {
    const point = await env.DB.prepare("INSERT INTO contact_points(kind,normalized_value,display_value) VALUES('email','utf8-schema@example.test','utf8-schema@example.test') RETURNING id").first<number>('id');
    const challenge = await env.DB.prepare(`INSERT INTO identity_challenges(public_id,campus_id,purpose,contact_point_id,code_hash,requester_bucket_hash,expires_at)
      VALUES('123e4567-e89b-42d3-a456-426614174811',1,'signup',?1,?2,?3,'2099-01-01') RETURNING id`)
      .bind(point, 'd'.repeat(64), 'e'.repeat(64)).first<number>('id');
    await env.DB.prepare("INSERT INTO identity_observations(id,campus_id,source,source_key,normalized_email) VALUES(88311,1,'signup','utf8-operation','utf8-schema@example.test')").run();
    await expect(env.DB.prepare(`INSERT INTO identity_account_operations(operation_id,campus_id,kind,challenge_id,observation_id,reserved_person_id,requested_display_name,requested_normalized_name,expires_at)
      VALUES('123e4567-e89b-42d3-a456-426614174812',1,'signup',?1,88311,188311,?2,'safe','2099-01-01')`).bind(challenge, '界'.repeat(171)).run()).rejects.toThrow();
  });

  it('makes ownership and identity audit history append-only', async () => {
    await env.DB.prepare("INSERT INTO identity_audit_events(campus_id,event_type,metadata_json) VALUES(1,'append_test','{}')").run();
    const auditId = await env.DB.prepare("SELECT id FROM identity_audit_events WHERE event_type='append_test' ORDER BY id DESC").first<number>('id');
    await expect(env.DB.prepare('UPDATE identity_audit_events SET event_type=?1 WHERE id=?2').bind('changed', auditId).run()).rejects.toThrow();
    await expect(env.DB.prepare('DELETE FROM identity_audit_events WHERE id=?1').bind(auditId).run()).rejects.toThrow();
  });

  it('keeps recovery approvals, holds, and reviewed owner snapshots append-only', async () => {
    for (const table of ['identity_recovery_decisions', 'identity_recovery_holds', 'identity_recovery_owner_snapshots', 'identity_recovery_notification_receipts']) {
      const triggers = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?1 ORDER BY name")
        .bind(table).all<{ name: string }>();
      expect(triggers.results.some(({ name }) => name.includes('append_only')), table).toBe(true);
    }
    const caseColumns = await env.DB.prepare('PRAGMA table_info(identity_recovery_cases)').all<{ name: string }>();
    expect(caseColumns.results.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'version', 'source_operation_id', 'claimed_target_hash', 'source_version',
    ]));
    await env.DB.prepare(`INSERT INTO identity_recovery_key_config(singleton_id,key_id,algorithm_version,verification_tag)
      VALUES(1,'v1',1,?1)`).bind('f'.repeat(64)).run();
    await expect(env.DB.prepare("UPDATE identity_recovery_key_config SET key_id='v2' WHERE singleton_id=1").run())
      .rejects.toThrow(/identity_recovery_key_config_append_only/);
    await expect(env.DB.prepare('DELETE FROM identity_recovery_key_config WHERE singleton_id=1').run())
      .rejects.toThrow(/identity_recovery_key_config_append_only/);
  });

  it('guards owner mutations with an append-only generation claim', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(88131,'Mutation Owner','mutation-owner@example.test')"),
      env.DB.prepare("INSERT INTO contact_points(id,kind,normalized_value,display_value) VALUES(88131,'email','mutation@example.test','mutation@example.test')"),
      env.DB.prepare("INSERT INTO person_contact_links(person_id,contact_point_id,kind,source) VALUES(88131,88131,'email','test')"),
      env.DB.prepare("INSERT INTO verified_contact_owners(contact_point_id,person_id,verification_method) VALUES(88131,88131,'admin_review')"),
    ]);
    await env.DB.prepare("INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation) VALUES(88131,1,88131,NULL,'revoke')").run();
    await expect(env.DB.prepare("INSERT INTO contact_owner_mutation_claims(contact_point_id,generation,expected_person_id,resulting_person_id,operation) VALUES(88131,1,88131,NULL,'revoke')").run()).rejects.toThrow();
    const claimId = await env.DB.prepare('SELECT id FROM contact_owner_mutation_claims WHERE contact_point_id=88131').first<number>('id');
    await expect(env.DB.prepare('UPDATE contact_owner_mutation_claims SET generation=2 WHERE id=?1').bind(claimId).run()).rejects.toThrow();
    await expect(env.DB.prepare('DELETE FROM contact_owner_mutation_claims WHERE id=?1').bind(claimId).run()).rejects.toThrow();
  });

  it('requires either an ordered person pair or an observation candidate, never a mixed case', async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88201, 'Pair A', 'pair-a@example.test')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88202, 'Pair B', 'pair-b@example.test')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88203, 'Candidate', 'candidate@example.test')"),
      env.DB.prepare("INSERT INTO people (id, display_name, email) VALUES (88204, 'Candidate Two', 'candidate-two@example.test')"),
      env.DB.prepare("INSERT INTO identity_observations (id, campus_id, source, source_key, status) VALUES (88201, 1, 'import', 'observation-88201', 'review')"),
      env.DB.prepare("INSERT INTO identity_resolution_cases (campus_id, person_a_id, person_b_id, score) VALUES (1, 88201, 88202, 50)"),
      env.DB.prepare("INSERT INTO identity_resolution_cases (campus_id, observation_id, candidate_person_id, score) VALUES (1, 88201, 88203, 50)"),
      env.DB.prepare("INSERT INTO identity_resolution_cases (campus_id, observation_id, candidate_person_id, score) VALUES (1, 88201, 88204, 51)"),
    ]);
    for (const sql of [
      "INSERT INTO identity_resolution_cases (campus_id, person_a_id, person_b_id, score) VALUES (1, 88202, 88201, 50)",
      "INSERT INTO identity_resolution_cases (campus_id, observation_id, score) VALUES (1, 88201, 50)",
      "INSERT INTO identity_resolution_cases (campus_id, observation_id, candidate_person_id, person_a_id, score) VALUES (1, 88201, 88203, 88201, 50)",
      "INSERT INTO identity_resolution_cases (campus_id, candidate_person_id, score) VALUES (1, 88203, 50)",
    ]) await expect(env.DB.prepare(sql).run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO identity_resolution_cases (campus_id, observation_id, candidate_person_id, score) VALUES (1, 88201, 88203, 51)").run()).rejects.toThrow();
  });
});
