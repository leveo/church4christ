import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sqlite(database: string, sql: string): string {
  return execFileSync('sqlite3', ['-batch', '-noheader', '-separator', '|', database], {
    encoding: 'utf8', input: sql,
  });
}

describe('Learning 0017 to 0018 D1 history upgrade', () => {
  it('terminalizes legacy running work and clears sync and credential crash markers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'c4c-learning-0018-d1-'));
    const database = join(directory, 'upgrade.sqlite3');
    try {
      sqlite(database, readFileSync('migrations/0001_init.sql', 'utf8'));
      sqlite(database, readFileSync('migrations/0017_learning.sql', 'utf8'));
      sqlite(database, `
        CREATE TABLE _migrations (name TEXT PRIMARY KEY);
        INSERT INTO _migrations(name) VALUES ('0001_init.sql'),('0017_learning.sql');
        INSERT INTO learning_provider_connections
          (id,provider,display_name,base_url,status,operation_marker)
        VALUES
          (1801,'canvas','Interrupted sync','https://sync-upgrade.example.test','active',
            '10000000-0000-4000-8000-000000000018'),
          (1802,'canvas','Interrupted credential','https://credential-upgrade.example.test','active',
            '20000000-0000-4000-8000-000000000018');
        INSERT INTO learning_provider_credentials
          (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version)
        VALUES (1802,zeroblob(16),zeroblob(12),'AES-256-GCM',1,1);
        INSERT INTO learning_sync_runs
          (id,connection_id,course_id,trigger_type,status,started_at)
        VALUES (1801,1801,NULL,'scheduled','running','2026-08-17T12:00:00.000Z');
      `);

      sqlite(database, readFileSync('migrations/0018_learning_sync_leases.sql', 'utf8'));
      sqlite(database, `INSERT INTO _migrations(name) VALUES ('0018_learning_sync_leases.sql');`);

      expect(sqlite(database, `
        SELECT r.status,r.finished_at,r.error_code,
          COALESCE(r.lease_marker,'NULL'),COALESCE(r.lease_expires_at,'NULL'),
          COALESCE(r.finalization_marker,'NULL'),
          COALESCE(sync.operation_marker,'NULL'),COALESCE(sync.operation_expires_at,'NULL'),
          COALESCE(credential.operation_marker,'NULL'),COALESCE(credential.operation_expires_at,'NULL'),
          (SELECT COUNT(*) FROM learning_provider_credentials WHERE connection_id=1802),
          (SELECT group_concat(name, ',') FROM _migrations ORDER BY name)
        FROM learning_sync_runs r
        JOIN learning_provider_connections sync ON sync.id=1801
        JOIN learning_provider_connections credential ON credential.id=1802
        WHERE r.id=1801;
      `).trim()).toBe([
        'failed', '2026-08-17T12:00:00.000Z', 'internal_error',
        'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', '1',
        '0001_init.sql,0017_learning.sql,0018_learning_sync_leases.sql',
      ].join('|'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
