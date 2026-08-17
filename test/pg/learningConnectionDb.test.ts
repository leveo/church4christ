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

  async function envelope(id: number) {
    const encoded = Buffer.alloc(32, 9).toString('base64');
    const ring = await importLearningCredentialKeyRing(JSON.stringify({ currentVersion: 1, keys: { 1: encoded } }));
    return encryptLearningCredential(ring, {
      provider: 'canvas', connectionId: id,
      plaintext: new TextEncoder().encode('{"accessToken":"pg-private"}'), expiresAt: null,
    });
  }

  it('matches D1 create/update/conflict/disconnect/reconnect atomic semantics', async () => {
    await createLearningConnection(db, {
      connectionId: 201, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await envelope(201),
    });
    expect(await updateLearningConnection(db, {
      connectionId: 201, expectedRevision: 0, provider: 'canvas', displayName: 'Updated',
      baseUrl: 'https://new-canvas.church.test', actorPersonId: actor,
    })).toMatchObject({ revision: 1 });
    await expect(updateLearningConnection(db, {
      connectionId: 201, expectedRevision: 0, provider: 'canvas', displayName: 'Stale',
      baseUrl: 'https://stale.test', actorPersonId: actor,
    })).rejects.toBeInstanceOf(LearningConnectionConflictError);
    expect(await disconnectLearningConnection(db, {
      connectionId: 201, expectedRevision: 1, actorPersonId: actor,
    })).toMatchObject({ status: 'disabled', revision: 2 });
    expect(await reconnectLearningConnection(db, {
      connectionId: 201, expectedRevision: 2, provider: 'canvas', baseUrl: 'https://new-canvas.church.test',
      actorPersonId: actor, credential: await envelope(201),
    })).toMatchObject({ status: 'active', revision: 3, deletedAt: null });
    expect(await getLearningConnection(db, 201, { includeDeleted: true })).toMatchObject({ revision: 3 });
    expect(await listLearningConnections(db, { limit: 100 })).toEqual([
      expect.objectContaining({ connectionId: 201, provider: 'canvas', revision: 3 }),
    ]);
  });
});
