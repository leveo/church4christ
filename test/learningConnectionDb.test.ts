import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LearningConnectionConflictError,
  createLearningConnection,
  disconnectLearningConnection,
  getLearningConnection,
  reconnectLearningConnection,
  listLearningConnections,
  updateLearningConnection,
  updateLearningConnectionHealth,
} from '../src/lib/learningConnectionDb';
import { encryptLearningCredential, importLearningCredentialKeyRing } from '../src/lib/learningCredentials';

const actor = 8_501;
const keySecret = JSON.stringify({ currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) } });

async function reset() {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM learning_provider_credentials'),
    env.DB.prepare('DELETE FROM learning_provider_connections'),
    env.DB.prepare('DELETE FROM people WHERE id=?').bind(actor),
    env.DB.prepare("INSERT INTO people (id,display_name,email,role) VALUES (?,'Learning Admin','learning-db@example.test','admin')").bind(actor),
  ]);
}

beforeEach(reset);

async function canvasEnvelope(connectionId: number, token = 'canvas-private-token') {
  const ring = await importLearningCredentialKeyRing(keySecret);
  return encryptLearningCredential(ring, {
    provider: 'canvas', connectionId,
    plaintext: new TextEncoder().encode(JSON.stringify({ accessToken: token })), expiresAt: null,
  });
}

function bytes(value: unknown): number[] {
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return value;
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (value instanceof Uint8Array) return [...value];
  if (value !== null && typeof value === 'object' && Number.isInteger((value as { byteLength?: unknown }).byteLength)) {
    return [...new Uint8Array(value as ArrayBuffer)];
  }
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

describe('Learning provider connection persistence (D1)', () => {
  it('atomically creates credentialed Canvas and pending credential-free Google connections', async () => {
    expect(await createLearningConnection(env.DB, {
      connectionId: 101, provider: 'canvas', displayName: 'Church Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(101),
    })).toMatchObject({ connectionId: 101, provider: 'canvas', status: 'active', revision: 0 });
    expect(await createLearningConnection(env.DB, {
      connectionId: 102, provider: 'google_classroom', displayName: 'Sunday School', baseUrl: null,
      actorPersonId: actor, credential: null,
    })).toMatchObject({ connectionId: 102, provider: 'google_classroom', status: 'pending', revision: 0 });
    const rows = await env.DB.prepare(
      'SELECT connection_id,ciphertext,nonce,envelope_version FROM learning_provider_credentials',
    ).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ connection_id: 101, envelope_version: 2 });
    expect(JSON.stringify(rows.results)).not.toContain('canvas-private-token');

    const invalidEnvelope = { ...(await canvasEnvelope(103)), extra: 'forbidden' };
    await expect(createLearningConnection(env.DB, {
      connectionId: 103, provider: 'canvas', displayName: 'Invalid', baseUrl: 'https://invalid.test',
      actorPersonId: actor, credential: invalidEnvelope as never,
    })).rejects.toThrow('learning_connection_invalid');
    expect(await env.DB.prepare('SELECT 1 FROM learning_provider_connections WHERE id=103').first()).toBeNull();
  });

  it('updates with optimistic concurrency and never partially applies a stale write', async () => {
    await createLearningConnection(env.DB, {
      connectionId: 111, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(111),
    });
    expect(await updateLearningConnection(env.DB, {
      connectionId: 111, expectedRevision: 0, provider: 'canvas', displayName: 'Canvas Updated',
      baseUrl: 'https://canvas-new.church.test', actorPersonId: actor,
    })).toMatchObject({ revision: 1, displayName: 'Canvas Updated', baseUrl: 'https://canvas-new.church.test' });
    await expect(updateLearningConnection(env.DB, {
      connectionId: 111, expectedRevision: 0, provider: 'canvas', displayName: 'Stale',
      baseUrl: 'https://stale.test', actorPersonId: actor,
    })).rejects.toBeInstanceOf(LearningConnectionConflictError);
    expect(await getLearningConnection(env.DB, 111, { includeDeleted: true })).toMatchObject({
      revision: 1, displayName: 'Canvas Updated', baseUrl: 'https://canvas-new.church.test',
    });
  });

  it('disconnects softly while atomically deleting the credential and reconnects only at the exact revision', async () => {
    await createLearningConnection(env.DB, {
      connectionId: 121, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(121),
    });
    const disabled = await disconnectLearningConnection(env.DB, {
      connectionId: 121, expectedRevision: 0, actorPersonId: actor,
    });
    expect(disabled).toMatchObject({ status: 'disabled', revision: 1 });
    expect(disabled.deletedAt).not.toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM learning_provider_credentials WHERE connection_id=?').bind(121).first()).toBeNull();
    await expect(disconnectLearningConnection(env.DB, {
      connectionId: 121, expectedRevision: 0, actorPersonId: actor,
    })).rejects.toBeInstanceOf(LearningConnectionConflictError);

    await expect(reconnectLearningConnection(env.DB, {
      connectionId: 121, expectedRevision: 0, provider: 'canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(121, 'stale-private-token'),
    })).rejects.toBeInstanceOf(LearningConnectionConflictError);
    expect(await env.DB.prepare('SELECT 1 FROM learning_provider_credentials WHERE connection_id=?').bind(121).first()).toBeNull();

    const reconnected = await reconnectLearningConnection(env.DB, {
      connectionId: 121, expectedRevision: 1, provider: 'canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(121, 'rotated-private-token'),
    });
    expect(reconnected).toMatchObject({ status: 'active', revision: 2, deletedAt: null });
    expect(await env.DB.prepare('SELECT key_version FROM learning_provider_credentials WHERE connection_id=?').bind(121).first())
      .toEqual({ key_version: 1 });
  });

  it('revision-gates health results and stores only bounded safe error codes', async () => {
    await createLearningConnection(env.DB, {
      connectionId: 131, provider: 'google_classroom', displayName: 'Google', baseUrl: null,
      actorPersonId: actor, credential: null,
    });
    for (const mismatch of [
      { expectedProvider: 'canvas' as const, expectedStatus: 'pending' as const },
      { expectedProvider: 'google_classroom' as const, expectedStatus: 'active' as const },
    ]) {
      await expect(updateLearningConnectionHealth(env.DB, {
        connectionId: 131, expectedRevision: 0, ...mismatch,
        ok: false, errorCode: 'provider_unavailable', actorPersonId: actor,
      })).rejects.toBeInstanceOf(LearningConnectionConflictError);
    }
    expect(await updateLearningConnectionHealth(env.DB, {
      connectionId: 131, expectedRevision: 0, expectedProvider: 'google_classroom', expectedStatus: 'pending',
      ok: false, errorCode: 'provider_unavailable', actorPersonId: actor,
    })).toMatchObject({ status: 'error', lastErrorCode: 'provider_unavailable', revision: 1 });
    await expect(updateLearningConnectionHealth(env.DB, {
      connectionId: 131, expectedRevision: 0, expectedProvider: 'google_classroom', expectedStatus: 'pending',
      ok: true, errorCode: null, actorPersonId: actor,
    })).rejects.toBeInstanceOf(LearningConnectionConflictError);
  });

  it('lists bounded safe connection metadata without exposing credential columns', async () => {
    await createLearningConnection(env.DB, {
      connectionId: 141, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(141),
    });
    await createLearningConnection(env.DB, {
      connectionId: 142, provider: 'google_classroom', displayName: 'Google', baseUrl: null,
      actorPersonId: actor, credential: null,
    });
    await disconnectLearningConnection(env.DB, { connectionId: 141, expectedRevision: 0, actorPersonId: actor });
    const rows = await listLearningConnections(env.DB, { includeDeleted: true, limit: 10 });
    expect(rows.map((item) => item.connectionId)).toEqual([141, 142]);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'baseUrl', 'connectionId', 'deletedAt', 'displayName', 'lastErrorCode',
      'lastSuccessfulSyncAt', 'provider', 'revision', 'status',
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/canvas-private-token|ciphertext|nonce|key_version/i);
    await expect(listLearningConnections(env.DB, { includeDeleted: true, limit: 0 })).rejects.toThrow('learning_connection_invalid');
  });

  it('atomically resolves concurrent update-vs-disconnect with no losing credential side effect', async () => {
    await createLearningConnection(env.DB, {
      connectionId: 151, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(151),
    });
    const results = await Promise.allSettled([
      updateLearningConnection(env.DB, {
        connectionId: 151, expectedRevision: 0, provider: 'canvas', displayName: 'Update winner',
        baseUrl: 'https://updated.church.test', actorPersonId: actor,
      }),
      disconnectLearningConnection(env.DB, { connectionId: 151, expectedRevision: 0, actorPersonId: actor }),
    ]);
    const winner = oneWinner(results);
    const connection = await getLearningConnection(env.DB, 151, { includeDeleted: true });
    const credential = await env.DB.prepare(
      'SELECT ciphertext FROM learning_provider_credentials WHERE connection_id=?',
    ).bind(151).first();
    expect(connection?.revision).toBe(1);
    if (winner === 0) {
      expect(connection).toMatchObject({ status: 'active', displayName: 'Update winner', deletedAt: null });
      expect(credential).not.toBeNull();
    } else {
      expect(connection).toMatchObject({ status: 'disabled', displayName: 'Canvas' });
      expect(connection?.deletedAt).not.toBeNull();
      expect(credential).toBeNull();
    }
    expect(await env.DB.prepare('SELECT operation_marker FROM learning_provider_connections WHERE id=?')
      .bind(151).first()).toEqual({ operation_marker: null });
  });

  it('keeps the winning reconnect credential under concurrent reconnect attempts', async () => {
    await createLearningConnection(env.DB, {
      connectionId: 161, provider: 'canvas', displayName: 'Canvas', baseUrl: 'https://canvas.church.test',
      actorPersonId: actor, credential: await canvasEnvelope(161),
    });
    await disconnectLearningConnection(env.DB, { connectionId: 161, expectedRevision: 0, actorPersonId: actor });
    const envelopes = [await canvasEnvelope(161, 'winner-a'), await canvasEnvelope(161, 'winner-b')] as const;
    const results = await Promise.allSettled([
      reconnectLearningConnection(env.DB, {
        connectionId: 161, expectedRevision: 1, provider: 'canvas', baseUrl: 'https://a.church.test',
        actorPersonId: actor, credential: envelopes[0],
      }),
      reconnectLearningConnection(env.DB, {
        connectionId: 161, expectedRevision: 1, provider: 'canvas', baseUrl: 'https://b.church.test',
        actorPersonId: actor, credential: envelopes[1],
      }),
    ]);
    const winner = oneWinner(results);
    const connection = await getLearningConnection(env.DB, 161, { includeDeleted: true });
    const stored = await env.DB.prepare(
      'SELECT ciphertext FROM learning_provider_credentials WHERE connection_id=?',
    ).bind(161).first<{ ciphertext: ArrayBuffer }>();
    expect(connection).toMatchObject({
      revision: 2, status: 'active', baseUrl: winner === 0 ? 'https://a.church.test' : 'https://b.church.test',
    });
    expect(stored).not.toBeNull();
    expect(stored?.ciphertext).toBeDefined();
    expect(bytes(stored?.ciphertext)).toEqual(bytes(envelopes[winner].ciphertext));
    expect(await env.DB.prepare('SELECT operation_marker FROM learning_provider_connections WHERE id=?')
      .bind(161).first()).toEqual({ operation_marker: null });
  });
});
