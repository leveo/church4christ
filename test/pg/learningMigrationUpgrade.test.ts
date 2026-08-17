import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('Learning 0017 to 0018 PostgreSQL history upgrade', () => {
  const sql = hasPg ? pgClient() : (null as never);

  beforeAll(async () => {
    await resetSchema(sql);
    await sql.unsafe(`CREATE TABLE _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
    )`);
    const legacyFiles = readdirSync('migrations-supabase')
      .filter((file) => file.endsWith('.sql') && file <= '0017_learning.sql')
      .sort();
    for (const file of legacyFiles) {
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(`migrations-supabase/${file}`, 'utf8'));
        await tx.unsafe('INSERT INTO _migrations(name) VALUES ($1)', [file]);
      });
    }
  });

  afterAll(async () => { await sql?.end(); });

  it('terminalizes legacy running work, clears crash markers, and preserves server-only ACLs', async () => {
    await sql.unsafe(`
      INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,operation_marker)
      VALUES
        (1801,'canvas','Interrupted sync','https://sync-upgrade.example.test','active',
          '10000000-0000-4000-8000-000000000018'),
        (1802,'canvas','Interrupted credential','https://credential-upgrade.example.test','active',
          '20000000-0000-4000-8000-000000000018');
      INSERT INTO learning_provider_credentials
        (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version)
      VALUES (1802,decode(repeat('00',16),'hex'),decode(repeat('00',12),'hex'),'AES-256-GCM',1,1);
      INSERT INTO learning_sync_runs
        (id,connection_id,course_id,trigger_type,status,started_at)
      VALUES (1801,1801,NULL,'scheduled','running','2026-08-17T12:00:00.000Z');
    `);

    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync('migrations-supabase/0018_learning_sync_leases.sql', 'utf8'));
      await tx.unsafe(`INSERT INTO _migrations(name) VALUES ('0018_learning_sync_leases.sql')`);
    });

    expect((await sql.unsafe(`
      SELECT r.status,r.finished_at,r.error_code,r.lease_marker,r.lease_expires_at,r.finalization_marker,
        sync.operation_marker,sync.operation_expires_at,
        credential.operation_marker AS credential_marker,
        credential.operation_expires_at AS credential_expires_at,
        (SELECT COUNT(*)::int FROM learning_provider_credentials WHERE connection_id=1802) AS credential_count
      FROM learning_sync_runs r
      JOIN learning_provider_connections sync ON sync.id=1801
      JOIN learning_provider_connections credential ON credential.id=1802
      WHERE r.id=1801
    `))[0]).toEqual({
      status: 'failed', finished_at: '2026-08-17T12:00:00.000Z', error_code: 'internal_error',
      lease_marker: null, lease_expires_at: null, finalization_marker: null,
      operation_marker: null, operation_expires_at: null,
      credential_marker: null, credential_expires_at: null, credential_count: 1,
    });
    expect((await sql.unsafe(`SELECT name FROM _migrations ORDER BY name DESC LIMIT 1`))[0])
      .toEqual({ name: '0018_learning_sync_leases.sql' });
    expect(await sql.unsafe(`
      SELECT c.relname,c.relrowsecurity,
        NOT EXISTS (
          SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) acl
          WHERE acl.grantee=0
        ) AS public_revoked
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('learning_provider_connections','learning_sync_runs')
      ORDER BY c.relname
    `)).toEqual([
      { relname: 'learning_provider_connections', relrowsecurity: true, public_revoked: true },
      { relname: 'learning_sync_runs', relrowsecurity: true, public_revoked: true },
    ]);
  });
});
