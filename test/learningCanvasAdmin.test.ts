import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { encodeCanvasCredential } from '../src/lib/learningCanvasAuth';
import {
  checkCanvasConnectionHealth,
  disconnectCanvasConnection,
  listCanvasCourseOptions,
  mapSelectedCanvasCourse,
  unmapSelectedCanvasCourse,
} from '../src/lib/learningCanvasAdmin';
import { encryptLearningCredential, importLearningCredentialKeyRing } from '../src/lib/learningCredentials';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const BASE_URL = 'https://canvas.church.example';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(73))) },
});

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
      keyRing: await importLearningCredentialKeyRing(KEY_SECRET), fetcher, nowEpochMs: NOW,
    };
  }

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
});
