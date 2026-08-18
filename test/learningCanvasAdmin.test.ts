import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb, AppStatement } from '../src/lib/appDb';
import { encodeCanvasCredential } from '../src/lib/learningCanvasAuth';
import {
  checkCanvasConnectionHealth,
  disconnectCanvasConnection,
  listCanvasCourseOptions,
  mapSelectedCanvasCourse,
  unmapSelectedCanvasCourse,
} from '../src/lib/learningCanvasAdmin';
import { recoverCanvasDisconnectCleanup } from '../src/lib/learningCanvasCleanup';
import { encryptLearningCredential, importLearningCredentialKeyRing } from '../src/lib/learningCredentials';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const BASE_URL = 'https://canvas.church.example';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(73))) },
});

function failFirstCanvasCleanupDelete(db: AppDb): AppDb {
  let mustFail = true;
  const wrap = (statement: AppStatement, cleanupDelete: boolean): AppStatement => ({
    bind(...values: unknown[]) { return wrap(statement.bind(...values), cleanupDelete); },
    first: <T = unknown>(column?: string) => statement.first<T>(column),
    all: <T = unknown>() => statement.all<T>(),
    async run<T = unknown>() {
      if (cleanupDelete && mustFail) {
        mustFail = false;
        throw new Error('injected_cleanup_delete_crash');
      }
      return statement.run<T>();
    },
  });
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return /^DELETE FROM learning_canvas_cleanup_tasks\b/u.test(sql.trim())
        ? wrap(statement, true) : statement;
    },
    batch: <T>(statements: AppStatement[]) => db.batch<T>(statements),
  };
}

describe('Canvas admin connection and course mapping', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM learning_courses WHERE connection_id=28302').run();
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=28302').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id=28303').run();
    await env.DB.prepare('DELETE FROM people WHERE id=28301').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(28301,'Canvas Admin','canvas-admin@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(28302,'canvas','Canvas',?1,'active',1,28301)`).bind(BASE_URL).run();
    await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(28303,'canvas-sunday-school','Canvas Sunday School')").run();
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(keyRing, {
      provider: 'canvas', connectionId: 28302,
      plaintext: encodeCanvasCredential({
        version: 1, accessToken: 'canvas-access', refreshToken: 'canvas-refresh',
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z',
        grantedScopes: (await import('../src/lib/learningCanvasProvider')).CANVAS_REQUIRED_SCOPES,
      }), expiresAt: null,
    });
    await env.DB.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(28302,?1,?2,?3,?4,?5,NULL)`).bind(
      envelope.ciphertext, envelope.nonce, envelope.algorithm,
      envelope.keyVersion, envelope.envelopeVersion,
    ).run();
  });

  async function input(fetcher: typeof fetch) {
    return {
      connectionId: 28302, clientId: 'canvas-client', clientSecret: 'canvas-secret',
      allowedOrigins: Object.freeze([BASE_URL]),
      keyRing: await importLearningCredentialKeyRing(KEY_SECRET), fetcher,
      now: () => NOW, signal: new AbortController().signal,
    };
  }

  it('propagates the parent request signal into stalled Canvas admin response bodies', async () => {
    const parent = new AbortController();
    const cancelled = vi.fn();
    let providerSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_raw: RequestInfo | URL, init?: RequestInit) => {
      providerSignal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => undefined),
        cancel: cancelled,
      }));
    });
    const pending = listCanvasCourseOptions(env.DB as AppDb, {
      ...await input(fetcher as typeof fetch), signal: parent.signal, now: Date.now,
    } as never);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    parent.abort();
    await expect(pending).rejects.toThrow();
    expect(providerSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('does not refresh, call, or revoke when an active issuer leaves the deployment allowlist', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    const admin = {
      ...await input(fetcher as typeof fetch),
      allowedOrigins: Object.freeze(['https://replacement-canvas.example']),
    };
    await expect(checkCanvasConnectionHealth(env.DB as AppDb, admin as never)).resolves.toEqual({
      ok: false, errorCode: 'authentication_required', connectionRevision: null,
    });
    await expect(listCanvasCourseOptions(env.DB as AppDb, admin as never)).rejects.toThrow();
    await expect(disconnectCanvasConnection(env.DB as AppDb, {
      ...admin, expectedRevision: 1, actorPersonId: 28301,
    } as never)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('health-checks and lists only strict Canvas course metadata with mapping state', async () => {
    const fetcher = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(raw));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer canvas-access');
      if (url.searchParams.get('per_page') === '1') return new Response('[]');
      return new Response(JSON.stringify([{
        id: 901, name: 'Genesis 1', workflow_state: 'available',
        created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-17T11:00:00.000Z',
      }]));
    });
    const admin = await input(fetcher as typeof fetch);
    await expect(checkCanvasConnectionHealth(env.DB as AppDb, admin)).resolves.toEqual({
      ok: true, errorCode: null, connectionRevision: 1,
    });
    const listed = await listCanvasCourseOptions(env.DB as AppDb, admin);
    expect(listed).toEqual(expect.objectContaining({
      connectionRevision: 1,
      programs: [expect.objectContaining({ programId: 28303 })],
      courses: [expect.objectContaining({
        mappedProgramId: null,
        course: expect.objectContaining({ externalCourseId: '901', displayName: 'Genesis 1' }),
      })],
    }));
  });

  it('refreshes an expired credential while recovering an error-state connection', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const { CANVAS_REQUIRED_SCOPES } = await import('../src/lib/learningCanvasProvider');
    const envelope = await encryptLearningCredential(keyRing, {
      provider: 'canvas', connectionId: 28302,
      plaintext: encodeCanvasCredential({
        version: 1, accessToken: 'expired-access', refreshToken: 'canvas-refresh',
        accessTokenExpiresAt: '2026-08-17T11:00:00.000Z',
        grantedScopes: CANVAS_REQUIRED_SCOPES,
      }), expiresAt: null,
    });
    await env.DB.batch([
      env.DB.prepare("UPDATE learning_provider_connections SET status='error' WHERE id=28302"),
      env.DB.prepare(`UPDATE learning_provider_credentials SET
        ciphertext=?1,nonce=?2,algorithm=?3,key_version=?4,envelope_version=?5
        WHERE connection_id=28302`).bind(
        envelope.ciphertext, envelope.nonce, envelope.algorithm,
        envelope.keyVersion, envelope.envelopeVersion,
      ),
    ]);
    const fetcher = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(raw));
      if (url.pathname === '/login/oauth2/token') {
        expect(init?.method).toBe('POST');
        expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('canvas-refresh');
        return new Response(JSON.stringify({
          access_token: 'refreshed-access', expires_in: 3600, token_type: 'Bearer',
        }), { headers: { 'content-type': 'application/json' } });
      }
      expect(url.pathname).toBe('/api/v1/courses');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer refreshed-access');
      return new Response('[]', { headers: { 'content-type': 'application/json' } });
    });

    await expect(checkCanvasConnectionHealth(env.DB as AppDb, await input(fetcher as typeof fetch)))
      .resolves.toEqual({ ok: true, errorCode: null, connectionRevision: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('CAS maps/unmaps an authoritative course and configures only the root-account allowlist', async () => {
    const fetcher = vi.fn(async (raw: RequestInfo | URL) => {
      const url = new URL(String(raw));
      expect(url.pathname).toBe('/api/v1/courses/901');
      return new Response(JSON.stringify({
        id: 901, name: 'Genesis 1', workflow_state: 'available',
        root_account_id: 'root-account-1',
        created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-17T11:00:00.000Z',
      }));
    });
    const admin = await input(fetcher as typeof fetch);
    const mapped = await mapSelectedCanvasCourse(env.DB as AppDb, {
      ...admin, externalCourseId: '901', programId: 28303, actorPersonId: 28301,
      expectedRevision: 1,
    });
    expect(mapped).toEqual(expect.objectContaining({
      connectionId: 28302, externalCourseId: '901', programId: 28303,
      connectionRevision: 2,
    }));
    expect(await env.DB.prepare('SELECT root_account_id FROM learning_canvas_webhook_configs WHERE connection_id=28302').first('root_account_id'))
      .toBe('root-account-1');
    await expect(unmapSelectedCanvasCourse(env.DB as AppDb, {
      ...admin, externalCourseId: '901', actorPersonId: 28301, expectedRevision: 1,
    })).rejects.toThrow();
    await expect(unmapSelectedCanvasCourse(env.DB as AppDb, {
      ...admin, externalCourseId: '901', actorPersonId: 28301, expectedRevision: 2,
    })).resolves.toEqual({ connectionId: 28302, connectionRevision: 3 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM learning_courses WHERE connection_id=28302 AND external_course_id='901'").first('count')).toBe(0);
  });

  it('rejects a missing or changed authoritative Canvas root account without mapping the course', async () => {
    const admin = await input((async (raw: RequestInfo | URL) => {
      const url = new URL(String(raw));
      const id = url.pathname.split('/').at(-1);
      return new Response(JSON.stringify({
        id, name: `Course ${id}`, workflow_state: 'available',
        ...(id === '902' ? {} : { root_account_id: 'different-root' }),
      }));
    }) as typeof fetch);
    await env.DB.prepare(`INSERT INTO learning_canvas_webhook_configs(connection_id,root_account_id)
      VALUES(28302,'root-account-1')`).run();
    await expect(mapSelectedCanvasCourse(env.DB as AppDb, {
      ...admin, externalCourseId: '902', programId: 28303, actorPersonId: 28301, expectedRevision: 1,
    })).rejects.toThrow();
    await expect(mapSelectedCanvasCourse(env.DB as AppDb, {
      ...admin, externalCourseId: '903', programId: 28303, actorPersonId: 28301, expectedRevision: 1,
    })).rejects.toThrow();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_courses
      WHERE connection_id=28302`).first('count')).toBe(0);
    expect((await env.DB.prepare(`SELECT revision,operation_marker FROM learning_provider_connections
      WHERE id=28302`).first()) as unknown).toEqual({ revision: 1, operation_marker: null });
  });

  it('revokes the Canvas token before a revisioned disconnect and never sends it in a URL', async () => {
    const fetcher = vi.fn(async (raw: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(raw));
      expect(url.toString()).toBe(`${BASE_URL}/login/oauth2/token`);
      expect(init?.method).toBe('DELETE');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer canvas-access');
      expect(url.searchParams.has('access_token')).toBe(false);
      return new Response(null, { status: 204 });
    });
    const admin = await input(fetcher as typeof fetch);
    const disconnected = await disconnectCanvasConnection(env.DB as AppDb, {
      ...admin, expectedRevision: 1, actorPersonId: 28301,
    });
    expect(disconnected).toEqual(expect.objectContaining({ status: 'disabled', revision: 2 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT count(*) AS count FROM learning_provider_credentials WHERE connection_id=28302').first('count')).toBe(0);
  });

  it('commits local disable and private-state deletion while revoke is unavailable, then one concurrent recovery wins', async () => {
    await env.DB.prepare(`INSERT INTO learning_canvas_webhook_configs(connection_id,root_account_id)
      VALUES(28302,'root-account-1')`).run();
    await env.DB.prepare(`INSERT INTO learning_canvas_event_receipts
      (connection_id,source_event_id,external_course_id,event_name,received_at,status,
       attempt_count,claim_marker,claim_expires_at,completed_at)
      VALUES(28302,'event-1','901','assignment_updated','2026-08-17T12:00:00.000Z',
       'succeeded',1,NULL,NULL,'2026-08-17T12:00:01.000Z')`).run();
    const unavailable = vi.fn(async () => new Response(null, { status: 503 }));
    const admin = await input(unavailable as typeof fetch);
    let queries = 0;
    const budgetedDb: AppDb = {
      prepare(sql: string) {
        queries += 1;
        return (env.DB as AppDb).prepare(sql);
      },
      batch: <T>(statements: Parameters<AppDb['batch']>[0]) => (env.DB as AppDb).batch<T>(statements),
    };
    await expect(disconnectCanvasConnection(budgetedDb, {
      ...admin, expectedRevision: 1, actorPersonId: 28301,
    })).resolves.toMatchObject({ status: 'disabled', revision: 2 });
    // Connection read + seven-statement local transaction + claim, connection
    // read, claim release, and terminal read stay inside the admin D1 budget.
    expect(queries).toBe(12);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT status,deleted_at FROM learning_provider_connections
      WHERE id=28302`).first()).toEqual({ status: 'disabled', deleted_at: expect.any(String) });
    expect(await env.DB.prepare(`SELECT
      (SELECT count(*) FROM learning_provider_credentials WHERE connection_id=28302) AS credentials,
      (SELECT count(*) FROM learning_canvas_webhook_configs WHERE connection_id=28302) AS webhooks,
      (SELECT count(*) FROM learning_canvas_event_receipts WHERE connection_id=28302) AS receipts,
      (SELECT count(*) FROM learning_canvas_cleanup_tasks WHERE connection_id=28302) AS cleanup`).first())
      .toEqual({ credentials: 0, webhooks: 0, receipts: 0, cleanup: 1 });

    const revoked = vi.fn(async () => new Response(null, { status: 204 }));
    const cleanup = {
      connectionId: 28302, clientId: 'canvas-client', clientSecret: 'canvas-secret',
      allowedOrigins: Object.freeze([BASE_URL]), keyRing: admin.keyRing,
      fetcher: revoked as typeof fetch, signal: new AbortController().signal,
      now: () => NOW + 1_000,
    };
    const recovered = await Promise.all([
      recoverCanvasDisconnectCleanup(env.DB as AppDb, cleanup),
      recoverCanvasDisconnectCleanup(env.DB as AppDb, cleanup),
    ]);
    expect(recovered.reduce((sum, result) => sum + result.selected, 0)).toBe(1);
    expect(recovered.reduce((sum, result) => sum + result.cleaned, 0)).toBe(1);
    expect(revoked).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_canvas_cleanup_tasks
      WHERE connection_id=28302`).first('count')).toBe(0);
  });

  it('finishes a crashed disconnect when Canvas reports the old access and retained refresh tokens invalid', async () => {
    const methods: string[] = [];
    let revokeCalls = 0;
    const fetcher = vi.fn(async (_raw: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'DELETE') {
        revokeCalls += 1;
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer canvas-access');
        return new Response(null, { status: revokeCalls === 1 ? 204 : 401 });
      }
      expect(method).toBe('POST');
      expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('canvas-refresh');
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    });
    const admin = await input(fetcher as typeof fetch);
    await expect(disconnectCanvasConnection(failFirstCanvasCleanupDelete(env.DB as AppDb), {
      ...admin, expectedRevision: 1, actorPersonId: 28301,
    })).resolves.toMatchObject({ status: 'disabled', revision: 2 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_canvas_cleanup_tasks
      WHERE connection_id=28302`).first('count')).toBe(1);

    const cleanup = {
      connectionId: 28302, clientId: admin.clientId, clientSecret: admin.clientSecret,
      allowedOrigins: admin.allowedOrigins, keyRing: admin.keyRing, fetcher: fetcher as typeof fetch,
      signal: new AbortController().signal, now: () => NOW + 1_000,
    };
    const recovered = await Promise.all([
      recoverCanvasDisconnectCleanup(env.DB as AppDb, cleanup),
      recoverCanvasDisconnectCleanup(env.DB as AppDb, cleanup),
    ]);
    expect(recovered.reduce((sum, result) => sum + result.selected, 0)).toBe(1);
    expect(recovered.reduce((sum, result) => sum + result.cleaned, 0)).toBe(1);
    expect(methods).toEqual(['DELETE', 'DELETE', 'POST']);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_canvas_cleanup_tasks
      WHERE connection_id=28302`).first('count')).toBe(0);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_provider_credentials
      WHERE connection_id=28302`).first('count')).toBe(0);
  });

  it('retains cleanup for retry when an invalid access token is followed by a transient refresh failure', async () => {
    const methods: string[] = [];
    let deletes = 0;
    const fetcher = vi.fn(async (_raw: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'DELETE') {
        deletes += 1;
        return new Response(null, { status: deletes === 1 ? 503 : 401 });
      }
      expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('canvas-refresh');
      return new Response(null, { status: 503 });
    });
    const admin = await input(fetcher as typeof fetch);
    await expect(disconnectCanvasConnection(env.DB as AppDb, {
      ...admin, expectedRevision: 1, actorPersonId: 28301,
    })).resolves.toMatchObject({ status: 'disabled', revision: 2 });
    await expect(recoverCanvasDisconnectCleanup(env.DB as AppDb, {
      connectionId: 28302, clientId: admin.clientId, clientSecret: admin.clientSecret,
      allowedOrigins: admin.allowedOrigins, keyRing: admin.keyRing, fetcher: fetcher as typeof fetch,
      signal: new AbortController().signal, now: () => NOW + 1_000,
    })).resolves.toEqual({ selected: 1, cleaned: 0, pending: 1 });
    expect(methods).toEqual(['DELETE', 'DELETE', 'POST']);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_canvas_cleanup_tasks
      WHERE connection_id=28302`).first('count')).toBe(1);
  });

  it('persists a retained-refresh rotation before revoking the replacement access token', async () => {
    const methods: string[] = [];
    let deletes = 0;
    const fetcher = vi.fn(async (_raw: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'POST') {
        expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('canvas-refresh');
        return new Response(JSON.stringify({
          access_token: 'replacement-access', refresh_token: 'replacement-refresh',
          expires_in: 3_600, token_type: 'Bearer',
        }), { headers: { 'content-type': 'application/json' } });
      }
      deletes += 1;
      const authorization = new Headers(init?.headers).get('authorization');
      if (deletes <= 2) {
        expect(authorization).toBe('Bearer canvas-access');
        return new Response(null, { status: deletes === 1 ? 503 : 401 });
      }
      expect(authorization).toBe('Bearer replacement-access');
      return new Response(null, { status: 204 });
    });
    const admin = await input(fetcher as typeof fetch);
    await expect(disconnectCanvasConnection(env.DB as AppDb, {
      ...admin, expectedRevision: 1, actorPersonId: 28301,
    })).resolves.toMatchObject({ status: 'disabled', revision: 2 });
    await expect(recoverCanvasDisconnectCleanup(env.DB as AppDb, {
      connectionId: 28302, clientId: admin.clientId, clientSecret: admin.clientSecret,
      allowedOrigins: admin.allowedOrigins, keyRing: admin.keyRing, fetcher: fetcher as typeof fetch,
      signal: new AbortController().signal, now: () => NOW + 1_000,
    })).resolves.toEqual({ selected: 1, cleaned: 1, pending: 0 });
    expect(methods).toEqual(['DELETE', 'DELETE', 'POST', 'DELETE']);
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_canvas_cleanup_tasks
      WHERE connection_id=28302`).first('count')).toBe(0);
  });

  it('leaves no operation marker when an anomalous active connection has no credential to migrate', async () => {
    await env.DB.prepare('DELETE FROM learning_provider_credentials WHERE connection_id=28302').run();
    const fetcher = vi.fn(async () => { throw new Error('network must not run'); });
    await expect(disconnectCanvasConnection(env.DB as AppDb, {
      ...await input(fetcher as typeof fetch), expectedRevision: 1, actorPersonId: 28301,
    })).rejects.toThrow();
    expect(await env.DB.prepare(`SELECT status,revision,operation_marker FROM learning_provider_connections
      WHERE id=28302`).first()).toEqual({ status: 'active', revision: 1, operation_marker: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('persists a refreshed cleanup envelope before a failed revoke and resumes without refreshing twice', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const expired = await encryptLearningCredential(keyRing, {
      provider: 'canvas', connectionId: 28302,
      plaintext: encodeCanvasCredential({
        version: 1, accessToken: 'expired-access', refreshToken: 'old-refresh',
        accessTokenExpiresAt: '2026-08-17T11:00:00.000Z',
        grantedScopes: (await import('../src/lib/learningCanvasProvider')).CANVAS_REQUIRED_SCOPES,
      }), expiresAt: null,
    });
    await env.DB.prepare(`UPDATE learning_provider_credentials SET
      ciphertext=?1,nonce=?2,algorithm=?3,key_version=?4,envelope_version=?5
      WHERE connection_id=28302`).bind(
      expired.ciphertext, expired.nonce, expired.algorithm, expired.keyVersion, expired.envelopeVersion,
    ).run();
    let refreshCalls = 0;
    let revokeCalls = 0;
    const fetcher = vi.fn(async (_raw: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        refreshCalls += 1;
        expect(new URLSearchParams(String(init.body)).get('refresh_token')).toBe('old-refresh');
        return new Response(JSON.stringify({
          access_token: 'rotated-access', refresh_token: 'rotated-refresh',
          expires_in: 3_600, token_type: 'Bearer',
        }), { headers: { 'content-type': 'application/json' } });
      }
      revokeCalls += 1;
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer rotated-access');
      return new Response(null, { status: revokeCalls === 1 ? 503 : 204 });
    });
    const admin = await input(fetcher as typeof fetch);
    await expect(disconnectCanvasConnection(env.DB as AppDb, {
      ...admin, expectedRevision: 1, actorPersonId: 28301,
    })).resolves.toMatchObject({ status: 'disabled', revision: 2 });
    expect(await env.DB.prepare(`SELECT count(*) AS count FROM learning_canvas_cleanup_tasks
      WHERE connection_id=28302`).first('count')).toBe(1);
    await expect(recoverCanvasDisconnectCleanup(env.DB as AppDb, {
      connectionId: 28302, clientId: admin.clientId, clientSecret: admin.clientSecret,
      allowedOrigins: admin.allowedOrigins, keyRing, fetcher: fetcher as typeof fetch,
      signal: new AbortController().signal, now: () => NOW + 1_000,
    })).resolves.toEqual({ selected: 1, cleaned: 1, pending: 0 });
    expect(refreshCalls).toBe(1);
    expect(revokeCalls).toBe(2);
  });
});
