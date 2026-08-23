import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { upsertContactPoint } from '../src/lib/identityDb';
import { attachIdentitySourceForSignedInSession, identityGatewaySessionContext, registerIdentitySource } from '../src/lib/identityGateway';

let id = 1_330_000_000;
const authEnv = {
  IDENTITY_VERIFICATION_SECRET: 'identity-source-schema-secret-that-is-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_SECRET: 'stable-identity-source-schema-key-secret-at-least-thirty-two-characters',
  IDENTITY_SOURCE_KEY_ID: 'v1',
};
async function pinTestSourceKeyConfig() {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authEnv.IDENTITY_SOURCE_KEY_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const tag = [...new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`identity-source-key-config:v1\0${authEnv.IDENTITY_SOURCE_KEY_ID}`)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(`INSERT INTO identity_source_key_config(singleton_id,key_id,algorithm_version,verification_tag)
    VALUES(1,'v1',1,?1) ON CONFLICT(singleton_id) DO NOTHING`).bind(tag).run();
}

describe('identity source database guards', () => {
  it('stores no raw PII fields in source, operation, or receipt ledgers', async () => {
    for (const table of ['identity_source_key_config', 'identity_source_records', 'identity_claim_operations', 'identity_source_attachment_receipts',
      'identity_source_attachment_commits', 'identity_source_provisional_operations', 'identity_source_provisional_receipts']) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      expect(columns.results.map((column) => column.name).join(' ')).not.toMatch(/\b(email|phone|name|amount|note|answer|provider_payload|ip_address)\b/i);
    }
  });

  it('accepts only fixed cryptographic source key digests at the storage boundary and rejects direct attachment', async () => {
    await pinTestSourceKeyConfig();
    const personId = ++id; const observationId = ++id;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
        .bind(personId, 'Guard Person', `guard-${personId}@example.test`),
      env.DB.prepare(`INSERT INTO identity_observations(id,campus_id,source,source_key,normalized_email,status)
        VALUES(?1,1,'giving',?2,?3,'provisional')`).bind(observationId, 'c'.repeat(64), `guard-source-${personId}@example.test`),
    ]);
    await expect(env.DB.prepare(`INSERT INTO identity_source_records(campus_id,source,source_record_key,source_key_id,
      observation_id,attachment_policy,source_digest) VALUES(1,'giving','victim@example.test','v1',?1,'signed_in_or_claim',?2)`)
      .bind(observationId, 'a'.repeat(64)).run()).rejects.toThrow();
    const sourceId = ++id;
    await env.DB.prepare(`INSERT INTO identity_source_records(id,campus_id,source,source_record_key,source_key_id,
      observation_id,attachment_policy,source_digest) VALUES(?1,1,'giving',?2,'v1',?3,'signed_in_or_claim',?4)`)
      .bind(sourceId, 'c'.repeat(64), observationId, 'a'.repeat(64)).run();
    await expect(env.DB.prepare("UPDATE identity_source_records SET state='linked',linked_person_id=?1 WHERE id=?2")
      .bind(personId, sourceId).run()).rejects.toThrow(/identity_source_direct_attachment_forbidden/);
  });

  it('rejects forged source inserts with provisional people or inconsistent observation bindings', async () => {
    await pinTestSourceKeyConfig();
    const provisionalId = ++id;
    await env.DB.prepare(`INSERT INTO people(id,display_name,email,active,identity_state,auth_disabled_at,provisional_source)
      VALUES(?1,'Forged Provisional',?2,0,'provisional',datetime('now'),'giving')`)
      .bind(provisionalId, `forged-provisional-${provisionalId}@identity.invalid`).run();
    const otherCampus = ++id;
    await env.DB.prepare('INSERT INTO campuses(id,slug,name) VALUES(?1,?2,?3)')
      .bind(otherCampus, `forged-source-${otherCampus}`, 'Forged Source Campus').run();
    const cases = [
      { campusId: 1, observationCampus: 1, observationSource: 'giving', status: 'provisional', provisionalPersonId: provisionalId },
      { campusId: 1, observationCampus: 1, observationSource: 'group', status: 'provisional', provisionalPersonId: null },
      { campusId: 1, observationCampus: otherCampus, observationSource: 'giving', status: 'provisional', provisionalPersonId: null },
      { campusId: 1, observationCampus: 1, observationSource: 'giving', status: 'review', provisionalPersonId: null },
    ] as const;
    for (const item of cases) {
      const observationId = ++id; const key = (++id).toString(16).padStart(64, '0');
      await env.DB.prepare(`INSERT INTO identity_observations(id,campus_id,source,source_key,status)
        VALUES(?1,?2,?3,?4,?5)`).bind(observationId, item.observationCampus, item.observationSource, key, item.status).run();
      await expect(env.DB.prepare(`INSERT INTO identity_source_records(campus_id,source,source_record_key,source_key_id,observation_id,
        attachment_policy,provisional_person_id,source_digest) VALUES(?1,'giving',?2,'v1',?3,'signed_in_or_claim',?4,?5)`)
        .bind(item.campusId, key, observationId, item.provisionalPersonId, 'a'.repeat(64)).run())
        .rejects.toThrow(/identity_source_insert_invalid/);
    }
  });

  it('keeps an attached source linked to the same person under NULL-safe direct SQL mutations', async () => {
    const first = ++id; const second = ++id;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)').bind(first, 'Immutable First', `immutable-${first}@example.test`),
      env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)').bind(second, 'Immutable Second', `immutable-${second}@example.test`),
    ]);
    const source = await registerIdentitySource(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: `immutable:${++id}`, email: `immutable-source-${id}@example.test`,
      attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'd'.repeat(64),
    });
    await attachIdentitySourceForSignedInSession(env.DB, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
      expectedVersion: 1, sourceDigest: 'd'.repeat(64), session: identityGatewaySessionContext({ personId: first, campusId: 1, sessionEpoch: 0 }) });
    await expect(env.DB.prepare("UPDATE identity_source_records SET state='review',linked_person_id=NULL WHERE id=?1")
      .bind(source.sourceRecordId).run()).rejects.toThrow(/identity_source_attachment_immutable/);
    await expect(env.DB.prepare("UPDATE identity_source_records SET state='review' WHERE id=?1")
      .bind(source.sourceRecordId).run()).rejects.toThrow(/identity_source_attachment_immutable/);
    await expect(env.DB.prepare("UPDATE identity_source_records SET state='linked',linked_person_id=?1 WHERE id=?2")
      .bind(second, source.sourceRecordId).run()).rejects.toThrow(/identity_source_attachment_immutable/);
    await expect(env.DB.prepare("UPDATE identity_observations SET status='dismissed',linked_person_id=NULL WHERE id=?1")
      .bind(source.observationId).run()).rejects.toThrow(/identity_source_observation_immutable/);
    await expect(env.DB.prepare("UPDATE identity_observations SET status='linked',linked_person_id=?1 WHERE id=?2")
      .bind(second, source.observationId).run()).rejects.toThrow(/identity_source_observation_immutable/);
    expect(await env.DB.prepare('SELECT state,linked_person_id FROM identity_source_records WHERE id=?1')
      .bind(source.sourceRecordId).first()).toEqual({ state: 'linked', linked_person_id: first });
  });

  it('makes successful proof receipts immutable', async () => {
    const personId = ++id;
    await env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
      .bind(personId, 'Receipt Person', `receipt-${personId}@example.test`).run();
    const source = await registerIdentitySource(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: `receipt:${++id}`, email: `receipt-source-${id}@example.test`,
      attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'b'.repeat(64),
    });
    await attachIdentitySourceForSignedInSession(env.DB, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: source.sourceRecordKey,
      expectedVersion: 1, sourceDigest: 'b'.repeat(64), session: identityGatewaySessionContext({ personId, campusId: 1, sessionEpoch: 0 }) });
    const receiptId = await env.DB.prepare('SELECT receipt_id FROM identity_source_attachment_receipts WHERE source_record_id=?1')
      .bind(source.sourceRecordId).first<string>('receipt_id');
    await expect(env.DB.prepare('UPDATE identity_source_attachment_receipts SET created_at=created_at WHERE receipt_id=?1').bind(receiptId).run())
      .rejects.toThrow(/append_only/);
    await expect(env.DB.prepare('DELETE FROM identity_source_attachment_receipts WHERE receipt_id=?1').bind(receiptId).run())
      .rejects.toThrow(/append_only/);
  });

  it('rolls back a receipt when the exact source CAS update affects no row', async () => {
    const personId = ++id;
    await env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
      .bind(personId, 'CAS Person', `cas-${personId}@example.test`).run();
    const source = await registerIdentitySource(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: `cas:${++id}`, email: `cas-source-${id}@example.test`,
      attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'e'.repeat(64),
    });
    const receiptId = crypto.randomUUID();
    await expect(env.DB.batch([
      env.DB.prepare(`INSERT INTO identity_source_attachment_receipts(receipt_id,campus_id,source_record_id,source_version,
        source_digest,person_id,proof_kind,session_epoch) VALUES(?1,1,?2,1,?3,?4,'signed_session',0)`)
        .bind(receiptId, source.sourceRecordId, 'e'.repeat(64), personId),
      env.DB.prepare(`UPDATE identity_source_records SET state='linked',linked_person_id=?1
        WHERE id=?2 AND version=999`).bind(personId, source.sourceRecordId),
      env.DB.prepare(`UPDATE identity_observations SET status='linked',linked_person_id=?1 WHERE id=?2`)
        .bind(personId, source.observationId),
    ])).rejects.toThrow(/identity_source_attachment_commit_invalid/);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_attachment_receipts WHERE receipt_id=?1')
      .bind(receiptId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT state,linked_person_id FROM identity_source_records WHERE id=?1')
      .bind(source.sourceRecordId).first()).toEqual({ state: 'unlinked', linked_person_id: null });
  });

  it('rolls back a signed receipt and source link when the observation transition updates zero rows', async () => {
    const personId = ++id;
    await env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
      .bind(personId, 'Observation CAS Person', `observation-cas-${personId}@example.test`).run();
    const source = await registerIdentitySource(env.DB, authEnv, {
      campusId: 1, source: 'giving', sourceRecordKey: `observation-cas:${++id}`,
      email: `observation-cas-source-${id}@example.test`, attachmentPolicy: 'signed_in_or_claim', sourceDigest: 'f'.repeat(64),
    });
    const receiptId = crypto.randomUUID();
    await expect(env.DB.batch([
      env.DB.prepare(`INSERT INTO identity_source_attachment_receipts(receipt_id,campus_id,source_record_id,source_version,
        source_digest,person_id,proof_kind,session_epoch) VALUES(?1,1,?2,1,?3,?4,'signed_session',0)`)
        .bind(receiptId, source.sourceRecordId, 'f'.repeat(64), personId),
      env.DB.prepare("UPDATE identity_source_records SET state='linked',linked_person_id=?1 WHERE id=?2 AND version=1")
        .bind(personId, source.sourceRecordId),
      env.DB.prepare("UPDATE identity_observations SET status='linked',linked_person_id=?1 WHERE id=-1").bind(personId),
      env.DB.prepare(`INSERT INTO identity_source_attachment_commits(commit_id,receipt_id,source_record_id,person_id)
        VALUES(?1,?2,?3,?4)`).bind(crypto.randomUUID(), receiptId, source.sourceRecordId, personId),
    ])).rejects.toThrow(/identity_source_attachment_commit_invalid/);
    expect(await env.DB.prepare('SELECT state,linked_person_id FROM identity_source_records WHERE id=?1')
      .bind(source.sourceRecordId).first()).toEqual({ state: 'unlinked', linked_person_id: null });
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_attachment_receipts WHERE receipt_id=?1')
      .bind(receiptId).first<number>('n')).toBe(0);
  });

  it('rolls back a provisional reservation when the source assignment CAS updates zero rows', async () => {
    const source = await registerIdentitySource(env.DB, authEnv, { campusId: 1, source: 'newcomer', sourceRecordKey: `provisional-cas:${++id}`,
      email: `provisional-cas-${id}@example.test`, name: `Provisional CAS ${id}`,
      attachmentPolicy: 'observation_only', sourceDigest: '9'.repeat(64) });
    const contact = await upsertContactPoint(env.DB, { kind: 'email', value: `provisional-cas-${id}@example.test` });
    const personId = ++id; const operationId = crypto.randomUUID(); const receiptId = crypto.randomUUID();
    await expect(env.DB.batch([
      env.DB.prepare(`INSERT INTO identity_source_provisional_operations(operation_id,campus_id,source_record_id,source_version,
        source_digest,reserved_person_id) VALUES(?1,1,?2,1,?3,?4)`)
        .bind(operationId, source.sourceRecordId, '9'.repeat(64), personId),
      env.DB.prepare(`INSERT INTO people(id,display_name,email,role,active,home_campus_id,membership_status,identity_state,auth_disabled_at,provisional_source)
        VALUES(?1,?2,?3,'member',0,1,'visitor','provisional',datetime('now'),'newcomer')`)
        .bind(personId, `Provisional CAS ${id}`, `provisional+${crypto.randomUUID()}@identity.invalid`),
      env.DB.prepare(`INSERT INTO person_contact_links(person_id,contact_point_id,kind,source,is_primary,notification_enabled)
        VALUES(?1,?2,'email','source_notification',0,1)`).bind(personId, contact.id),
      env.DB.prepare(`UPDATE identity_source_records SET provisional_person_id=?1
        WHERE id=?2 AND version=999`).bind(personId, source.sourceRecordId),
      env.DB.prepare(`INSERT INTO identity_source_provisional_receipts(receipt_id,operation_id,source_record_id,source_version,
        source_digest,person_id) VALUES(?1,?2,?3,1,?4,?5)`)
        .bind(receiptId, operationId, source.sourceRecordId, '9'.repeat(64), personId),
    ])).rejects.toThrow(/identity_source_provisional_commit_invalid/);
    expect(await env.DB.prepare('SELECT count(*) n FROM people WHERE id=?1').bind(personId).first<number>('n')).toBe(0);
    expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_provisional_operations WHERE operation_id=?1')
      .bind(operationId).first<number>('n')).toBe(0);
  });

  it('blocks direct version replacement while the current source version has a provisional reservation', async () => {
    const source = await registerIdentitySource(env.DB, authEnv, { campusId: 1, source: 'import', sourceRecordKey: `reserved-version:${++id}`,
      email: `reserved-version-${id}@example.test`, attachmentPolicy: 'observation_only', sourceDigest: '8'.repeat(64) });
    await env.DB.prepare(`INSERT INTO identity_source_provisional_operations(operation_id,campus_id,source_record_id,source_version,
      source_digest,reserved_person_id) VALUES(?1,1,?2,1,?3,?4)`)
      .bind(crypto.randomUUID(), source.sourceRecordId, '8'.repeat(64), ++id).run();
    await expect(env.DB.prepare(`UPDATE identity_source_records SET version=2,source_digest=?1
      WHERE id=?2`).bind('7'.repeat(64), source.sourceRecordId).run())
      .rejects.toThrow(/identity_source_version_conflict/);
  });

  it('revalidates D1 membership, person, and merge eligibility inside the receipt transaction', async () => {
    for (const kind of ['membership', 'auth-disabled', 'merged'] as const) {
      const personId = ++id; const canonicalId = ++id;
      await env.DB.batch([
        env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
          .bind(personId, `Eligibility ${kind}`, `eligibility-${personId}@example.test`),
        env.DB.prepare('INSERT INTO people(id,display_name,email) VALUES(?1,?2,?3)')
          .bind(canonicalId, `Eligibility Canonical ${kind}`, `eligibility-canonical-${canonicalId}@example.test`),
      ]);
      const source = await registerIdentitySource(env.DB, authEnv, { campusId: 1, source: 'giving', sourceRecordKey: `eligibility-${kind}:${++id}`,
        email: `eligibility-source-${id}@example.test`, attachmentPolicy: 'signed_in_or_claim', sourceDigest: '6'.repeat(64) });
      if (kind === 'membership') {
        await env.DB.prepare('UPDATE campus_memberships SET active=0 WHERE person_id=?1 AND campus_id=1').bind(personId).run();
      } else if (kind === 'auth-disabled') {
        await env.DB.prepare("UPDATE people SET auth_disabled_at=datetime('now') WHERE id=?1").bind(personId).run();
      } else {
        await env.DB.prepare(`INSERT INTO person_merge_redirects(loser_person_id,canonical_person_id)
          VALUES(?1,?2)`).bind(personId, canonicalId).run();
      }
      await expect(env.DB.prepare(`INSERT INTO identity_source_attachment_receipts(receipt_id,campus_id,source_record_id,
        source_version,source_digest,person_id,proof_kind,session_epoch) VALUES(?1,1,?2,1,?3,?4,'signed_session',0)`)
        .bind(crypto.randomUUID(), source.sourceRecordId, '6'.repeat(64), personId).run())
        .rejects.toThrow(/identity_source_attachment_proof_invalid/);
      expect(await env.DB.prepare('SELECT count(*) n FROM identity_source_attachment_receipts WHERE source_record_id=?1')
        .bind(source.sourceRecordId).first<number>('n')).toBe(0);
    }
  });
});
