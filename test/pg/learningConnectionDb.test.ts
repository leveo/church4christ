import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  LearningConnectionConflictError,
  createLearningConnection,
  disconnectLearningConnection,
  getLearningConnection,
  listLearningConnections,
  reconnectLearningConnection,
  updateLearningConnection,
} from '../../src/lib/learningConnectionDb';
import { encryptLearningCredential, importLearningCredentialKeyRing } from '../../src/lib/learningCredentials';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

describe.skipIf(!hasPg)('Learning provider connection persistence (PostgreSQL)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  let db: AppDb;
  const actor = 8_601;

  beforeAll(async () => {
    await resetSchema(sql);
    execFileSync(process.execPath, ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    db = new PgAdapter(sql);
  });
  beforeEach(async () => {
    await sql.unsafe(`TRUNCATE learning_provider_connections, people RESTART IDENTITY CASCADE;
      INSERT INTO people (id,display_name,email,role) VALUES (8601,'Learning Admin','learning-pg@example.test','admin');`);
  });
  afterAll(async () => { await sql?.end(); });

  async function envelope(id: number, token = 'pg-private') {
    const encoded = Buffer.alloc(32, 9).toString('base64');
    const ring = await importLearningCredentialKeyRing(JSON.stringify({ currentVersion: 1, keys: { 1: encoded } }));
    return encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: id,
      plaintext: new TextEncoder().encode(JSON.stringify({ accessToken: token })), expiresAt: null,
    });
  }

  const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function bytes(value: unknown): number[] {
    if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
    if (value instanceof Uint8Array) return [...value];
    throw new TypeError('expected credential bytes');
  }

  function oneWinner<T>(results: readonly PromiseSettledResult<T>[]): number {
    const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : []);
    expect(winners).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(LearningConnectionConflictError);
    }
    return winners[0];
  }

  it('matches D1 create/update/conflict/disconnect/reconnect atomic semantics', async () => {
    await createLearningConnection(db, {
      connectionId: 201, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await envelope(201),
    });
    expect(await updateLearningConnection(db, {
      connectionId: 201, expectedRevision: 0, provider: 'canvas', displayName: 'Updated',
      baseUrl: 'https://new-canvas.church.test', actorPersonId: actor,
    } as never)).toMatchObject({ revision: 1, baseUrl: 'https://canvas.church.test' });
    await expect(updateLearningConnection(db, {
      connectionId: 201, expectedRevision: 0, provider: 'canvas', displayName: 'Stale',
      baseUrl: 'https://stale.test', actorPersonId: actor,
    } as never)).rejects.toBeInstanceOf(LearningConnectionConflictError);
    expect(await disconnectLearningConnection(db, {
      connectionId: 201, expectedRevision: 1, actorPersonId: actor,
    })).toMatchObject({ status: 'disabled', revision: 2 });
    expect(await reconnectLearningConnection(db, {
      connectionId: 201, expectedRevision: 2, provider: 'canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await envelope(201),
    })).toMatchObject({ status: 'active', revision: 3, deletedAt: null });
    expect(await getLearningConnection(db, 201, { includeDeleted: true })).toMatchObject({ revision: 3 });
    expect(await listLearningConnections(db, { limit: 100 })).toEqual([
      expect.objectContaining({ connectionId: 201, provider: 'canvas', revision: 3 }),
    ]);
  });

  it('serializes update-vs-disconnect before deleting the credential', async () => {
    await createLearningConnection(db, {
      connectionId: 211, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await envelope(211),
    });
    await sql.unsafe(`CREATE OR REPLACE FUNCTION learning_test_delay_delete() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN OLD; END $$;
      CREATE TRIGGER learning_test_delay_delete BEFORE DELETE ON learning_provider_credentials
      FOR EACH ROW EXECUTE FUNCTION learning_test_delay_delete();`);
    try {
      const disconnect = disconnectLearningConnection(db, {
        connectionId: 211, expectedRevision: 0, actorPersonId: actor,
      });
      await pause(25);
      const update = updateLearningConnection(db, {
        connectionId: 211, expectedRevision: 0, provider: 'canvas', displayName: 'Update winner',
        baseUrl: 'https://updated.church.test', actorPersonId: actor,
      } as never);
      const results = await Promise.allSettled([disconnect, update]);
      const winner = oneWinner(results);
      const connection = await getLearningConnection(db, 211, { includeDeleted: true });
      const credential = await sql.unsafe('SELECT ciphertext FROM learning_provider_credentials WHERE connection_id=211');
      expect(connection?.revision).toBe(1);
      if (winner === 0) {
        expect(connection).toMatchObject({ status: 'disabled', displayName: 'Canvas' });
        expect(credential).toHaveLength(0);
      } else {
        expect(connection).toMatchObject({
          status: 'active', displayName: 'Update winner', baseUrl: 'https://canvas.church.test', deletedAt: null,
        });
        expect(credential).toHaveLength(1);
      }
      expect((await sql.unsafe('SELECT operation_marker FROM learning_provider_connections WHERE id=211'))[0])
        .toEqual({ operation_marker: null });
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS learning_test_delay_delete ON learning_provider_credentials');
      await sql.unsafe('DROP FUNCTION IF EXISTS learning_test_delay_delete()');
    }
  });

  it('serializes reconnect-vs-reconnect so a loser cannot replace the winner credential', async () => {
    await createLearningConnection(db, {
      connectionId: 221, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await envelope(221),
    });
    await disconnectLearningConnection(db, { connectionId: 221, expectedRevision: 0, actorPersonId: actor });
    const envelopes = [await envelope(221, 'winner-a'), await envelope(221, 'winner-b')] as const;
    await sql.unsafe(`CREATE OR REPLACE FUNCTION learning_test_delay_upsert() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
      CREATE TRIGGER learning_test_delay_upsert AFTER INSERT OR UPDATE ON learning_provider_credentials
      FOR EACH ROW EXECUTE FUNCTION learning_test_delay_upsert();`);
    try {
      const first = reconnectLearningConnection(db, {
        connectionId: 221, expectedRevision: 1, provider: 'canvas', baseUrl: 'https://canvas.church.test',
        actorPersonId: actor, credential: envelopes[0],
      });
      await pause(25);
      const second = reconnectLearningConnection(db, {
        connectionId: 221, expectedRevision: 1, provider: 'canvas', baseUrl: 'https://canvas.church.test',
        actorPersonId: actor, credential: envelopes[1],
      });
      const results = await Promise.allSettled([first, second]);
      const winner = oneWinner(results);
      const connection = await getLearningConnection(db, 221, { includeDeleted: true });
      const stored = (await sql.unsafe<{ ciphertext: Uint8Array }[]>(
        'SELECT ciphertext FROM learning_provider_credentials WHERE connection_id=221',
      ))[0];
      expect(connection).toMatchObject({
        revision: 2, status: 'active', baseUrl: 'https://canvas.church.test',
      });
      expect(bytes(stored?.ciphertext)).toEqual(bytes(envelopes[winner].ciphertext));
      expect((await sql.unsafe('SELECT operation_marker FROM learning_provider_connections WHERE id=221'))[0])
        .toEqual({ operation_marker: null });
    } finally {
      await sql.unsafe('DROP TRIGGER IF EXISTS learning_test_delay_upsert ON learning_provider_credentials');
      await sql.unsafe('DROP FUNCTION IF EXISTS learning_test_delay_upsert()');
    }
  });
});
