import { describe, expect, it, vi } from 'vitest';
import { LearningConnectionConflictError } from '../src/lib/learningConnectionDb';
import type { SessionUser } from '../src/lib/types';
import { ALL, createLearningConnectionActionHandler } from '../src/pages/admin/learning/connections';

function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 7, email: 'learning@example.test', displayName: 'Learning Admin', role: 'admin',
    isAdmin: true, isEditor: false, finance: 0, memberTeamIds: [], leaderTeamIds: [],
    lang: 'en', isSuperAdmin: false, adminAreas: ['learning'], ...over,
  };
}

function poisonedContext(modules: string[], actor: SessionUser | null = user(), headers: HeadersInit = {}): never {
  const request = new Request('https://church.test/admin/learning/connections', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new ReadableStream({ pull() { throw new Error('body read'); } }, { highWaterMark: 0 }),
  });
  const db = new Proxy({}, { get() { throw new Error('db read'); } });
  return { request, url: new URL(request.url), locals: { modules: new Set(modules), user: actor, db } } as never;
}

function unprovenPoisonedContext(headers: HeadersInit = {}): { context: never; wasPulled: () => boolean } {
  let pulled = false;
  const request = new Request('https://church.test/admin/learning/connections', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.error(new Error('body read'));
      },
    }, { highWaterMark: 0 }),
  });
  return {
    context: {
      request, url: new URL(request.url),
      locals: { modules: new Set(['learning']), user: user(), db: {} },
    } as never,
    wasPulled: () => pulled,
  };
}

const deps = () => ({
  keySecret: JSON.stringify({ currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(4))) } }),
  nextConnectionId: vi.fn(() => 401),
  createConnection: vi.fn(async () => ({ connectionId: 401 })),
  updateConnection: vi.fn(async () => ({ connectionId: 401 })),
  reconnectConnection: vi.fn(async () => ({ connectionId: 401 })),
  disconnectConnection: vi.fn(async () => ({ connectionId: 401 })),
  loadConnection: vi.fn(async () => ({
    provider: 'canvas' as const, baseUrl: 'https://canvas.test', revision: 0, status: 'active' as const,
  })),
  checkHealth: vi.fn(async (): Promise<
    { readonly ok: true; readonly errorCode: null }
    | { readonly ok: false; readonly errorCode: 'provider_unavailable' }
  > => ({ ok: true, errorCode: null })),
  updateHealth: vi.fn(async () => ({ connectionId: 401 })),
});

describe('Learning connection action HTTP boundary', () => {
  it('checks capability, Learning area, and same-origin CSRF before body/database/secrets', async () => {
    const injected = deps();
    const keyRead = vi.fn(() => { throw new Error('secret read'); });
    const handler = createLearningConnectionActionHandler({ ...injected, keySecret: keyRead });
    expect((await handler(poisonedContext([]))).status).toBe(404);
    expect((await handler(poisonedContext(['learning'], user({ adminAreas: [] })))).status).toBe(403);
    expect((await handler(poisonedContext(['learning'], user(), { origin: 'https://evil.test' }))).status).toBe(403);
    expect(keyRead).not.toHaveBeenCalled();
  });

  it('accepts exact Origin or a same-origin fetch proof and rejects every unproven mutation', async () => {
    const handler = createLearningConnectionActionHandler(deps());
    const call = (headers: HeadersInit) => {
      const request = new Request('https://church.test/admin/learning/connections', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: 'action=health_check&connection_id=401&revision=0&provider=canvas&status=active',
      });
      return handler({ request, url: new URL(request.url), locals: {
        modules: new Set(['learning']), user: user(), db: {},
      } } as never);
    };
    expect((await call({ origin: 'https://church.test' })).status).toBe(303);
    expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(303);
    for (const [label, headers] of [
      ['missing', {}],
      ['none', { 'sec-fetch-site': 'none' }],
      ['same-site', { 'sec-fetch-site': 'same-site' }],
      ['cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['unknown', { 'sec-fetch-site': 'unexpected' }],
      ['mismatched Origin', { origin: 'https://attacker.test', 'sec-fetch-site': 'same-origin' }],
    ] as const) expect.soft((await call(headers)).status, label).toBe(403);
  });

  it('rejects a mutation with no provenance before pulling its body', async () => {
    const poisoned = unprovenPoisonedContext();
    const response = await createLearningConnectionActionHandler(deps())(poisoned.context);
    expect(response.status).toBe(403);
    expect(poisoned.wasPulled()).toBe(false);
    expect((poisoned.context as { request: Request }).request.body?.locked).toBe(false);
  });

  it('advertises POST and rejects a direct non-POST invocation before body access', async () => {
    const all = await ALL({} as never);
    expect(all.status).toBe(405);
    expect(all.headers.get('allow')).toBe('POST');
    const request = new Request('https://church.test/admin/learning/connections', { method: 'GET' });
    const response = await createLearningConnectionActionHandler(deps())({
      request, url: new URL(request.url), locals: { modules: new Set(['learning']), user: user(), db: {} },
    } as never);
    expect(response.status).toBe(405);
  });

  it('rejects unsupported media and oversized bodies with safe no-store responses before DB access', async () => {
    const handler = createLearningConnectionActionHandler(deps());
    for (const [contentType, contentLength, status] of [
      ['text/plain', undefined, 415],
      ['application/x-www-form-urlencoded', '999999', 413],
    ] as const) {
      const request = new Request('https://church.test/admin/learning/connections', {
        method: 'POST', headers: {
          'content-type': contentType, origin: 'https://church.test',
          ...(contentLength ? { 'content-length': contentLength } : {}),
        }, body: 'private-token',
      });
      const db = new Proxy({}, { get() { throw new Error('db read'); } });
      const response = await handler({ request, url: new URL(request.url), locals: {
        modules: new Set(['learning']), user: user(), db,
      } } as never);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).not.toContain('private-token');
    }
  });

  it('creates Canvas, performs injected health-check, and returns only fixed safe redirects', async () => {
    const injected = deps();
    const handler = createLearningConnectionActionHandler(injected);
    const call = async (body: string) => handler({
      request: new Request('https://church.test/admin/learning/connections', {
        method: 'POST', headers: {
          'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
        }, body,
      }),
      url: new URL('https://church.test/admin/learning/connections'),
      locals: { modules: new Set(['learning']), user: user(), db: {} },
    } as never);

    const created = await call('action=create&provider=canvas&display_name=Canvas&base_url=https%3A%2F%2Fcanvas.test&access_token=private-token');
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/admin/learning?saved=connection_created');
    expect(JSON.stringify(injected.createConnection.mock.calls)).not.toContain('private-token');

    const checked = await call('action=health_check&connection_id=401&revision=0&provider=canvas&status=active');
    expect(checked.headers.get('location')).toBe('/admin/learning?saved=health_checked');
    expect(injected.checkHealth).toHaveBeenCalledTimes(1);
    expect(injected.updateHealth).toHaveBeenCalledWith({}, expect.objectContaining({
      connectionId: 401, expectedRevision: 0, ok: true, actorPersonId: 7,
      expectedProvider: 'canvas', expectedStatus: 'active',
    }));
  });

  it('rejects stale health revision/provider/status before calling the provider', async () => {
    const cases = [
      { revision: 1, provider: 'canvas', status: 'active' },
      { revision: 0, provider: 'google_classroom', status: 'active' },
      { revision: 0, provider: 'canvas', status: 'error' },
    ] as const;
    for (const expected of cases) {
      const injected = deps();
      const handler = createLearningConnectionActionHandler(injected);
      const body = new URLSearchParams({
        action: 'health_check', connection_id: '401', revision: String(expected.revision),
        provider: expected.provider, status: expected.status,
      });
      const response = await handler({
        request: new Request('https://church.test/admin/learning/connections', {
          method: 'POST', headers: {
            'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
          }, body,
        }),
        url: new URL('https://church.test/admin/learning/connections'),
        locals: { modules: new Set(['learning']), user: user(), db: {} },
      } as never);
      expect(response.headers.get('location')).toBe('/admin/learning?error=connection_conflict');
      expect(injected.checkHealth).not.toHaveBeenCalled();
      expect(injected.updateHealth).not.toHaveBeenCalled();
    }
  });

  it('discards a health result when the revision changes during the provider check', async () => {
    const injected = deps();
    injected.updateHealth.mockRejectedValue(new LearningConnectionConflictError());
    const handler = createLearningConnectionActionHandler(injected);
    const response = await handler({
      request: new Request('https://church.test/admin/learning/connections', {
        method: 'POST', headers: {
          'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
        }, body: 'action=health_check&connection_id=401&revision=0&provider=canvas&status=active',
      }),
      url: new URL('https://church.test/admin/learning/connections'),
      locals: { modules: new Set(['learning']), user: user(), db: {} },
    } as never);
    expect(injected.checkHealth).toHaveBeenCalledTimes(1);
    expect(response.headers.get('location')).toBe('/admin/learning?error=connection_conflict');
  });

  it('persists a failed health result but redirects to an allowlisted non-success error', async () => {
    const injected = deps();
    injected.checkHealth.mockResolvedValue({ ok: false, errorCode: 'provider_unavailable' });
    const handler = createLearningConnectionActionHandler(injected);
    const request = new Request('https://church.test/admin/learning/connections', {
      method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
      }, body: 'action=health_check&connection_id=401&revision=0&provider=canvas&status=active',
    });
    const response = await handler({ request, url: new URL(request.url), locals: {
      modules: new Set(['learning']), user: user(), db: {},
    } } as never);
    expect(injected.updateHealth).toHaveBeenCalledWith({}, expect.objectContaining({
      ok: false, errorCode: 'provider_unavailable',
    }));
    expect(response.headers.get('location')).toBe('/admin/learning?error=provider_unavailable');
  });

  it('creates a pending Google connection without reading the encryption secret', async () => {
    const injected = deps();
    const keyRead = vi.fn(() => { throw new Error('must not read'); });
    const handler = createLearningConnectionActionHandler({ ...injected, keySecret: keyRead });
    const request = new Request('https://church.test/admin/learning/connections', {
      method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
      }, body: 'action=create&provider=google_classroom&display_name=Google+Classroom',
    });
    const response = await handler({ request, url: new URL(request.url), locals: {
      modules: new Set(['learning']), user: user(), db: {},
    } } as never);
    expect(response.headers.get('location')).toBe('/admin/learning?saved=connection_created');
    expect(keyRead).not.toHaveBeenCalled();
    expect(injected.createConnection).toHaveBeenCalledWith({}, expect.objectContaining({
      provider: 'google_classroom', baseUrl: null, credential: null,
    }));
  });

  it('maps malformed, stale, keyring, and unknown failures to fixed codes without secret leakage', async () => {
    const injected = deps();
    injected.disconnectConnection.mockRejectedValue(new Error('canvas-private-token ciphertext nonce'));
    const handler = createLearningConnectionActionHandler(injected);
    const request = new Request('https://church.test/admin/learning/connections', {
      method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
      }, body: 'action=disconnect&connection_id=401&revision=0',
    });
    const response = await handler({ request, url: new URL(request.url), locals: {
      modules: new Set(['learning']), user: user(), db: {},
    } } as never);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning?error=connection_failed');
    expect(response.headers.get('location')).not.toMatch(/private|ciphertext|nonce/);
  });
});
