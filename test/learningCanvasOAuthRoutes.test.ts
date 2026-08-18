import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../src/lib/types';
import { createCanvasOAuthStartHandler } from '../src/pages/admin/learning/canvas/start';
import { createCanvasOAuthCallbackHandler } from '../src/pages/admin/learning/canvas/callback';

const STATE = 's'.repeat(43);
const BASE_URL = 'https://canvas.church.example';

function user(): SessionUser {
  return {
    id: 61, email: 'canvas@example.test', displayName: 'Canvas Admin', role: 'admin',
    isAdmin: true, isEditor: false, finance: 0, memberTeamIds: [], leaderTeamIds: [],
    lang: 'en', isSuperAdmin: false, adminAreas: ['learning'],
  };
}

function context(request: Request, options: {
  modules?: string[]; user?: object | null; cookie?: string; db?: object;
} = {}): never {
  return {
    request, url: new URL(request.url),
    locals: {
      modules: new Set(options.modules ?? ['learning']),
      user: options.user === undefined ? user() : options.user,
      db: options.db ?? {},
    },
    cookies: { get: vi.fn(() => options.cookie === undefined ? { value: 'session-binding' } : { value: options.cookie }) },
  } as never;
}

const startDeps = () => ({
  appOrigin: 'https://church.test', clientId: 'canvas-client', keySecret: 'key-secret',
  canvasAllowedOrigins: JSON.stringify([BASE_URL]),
  importKeyRing: vi.fn(async () => ({ ring: true })),
  beginState: vi.fn(async () => ({
    authorizationUrl: `${BASE_URL}/login/oauth2/auth?client_id=canvas-client&state=${STATE}`,
    state: STATE, connectionRevision: 4,
  })),
  now: vi.fn(() => Date.parse('2026-08-17T12:00:00.000Z')),
});

describe('Canvas OAuth admin routes', () => {
  it('starts exact-origin Canvas authorization with DB-bound base URL and PKCE state', async () => {
    const deps = startDeps();
    const request = new Request('https://church.test/admin/learning/canvas/start', {
      method: 'POST', headers: {
        origin: 'https://church.test', 'content-type': 'application/x-www-form-urlencoded',
      }, body: 'connection_id=81&revision=3&base_url=https%3A%2F%2Fcanvas.church.example',
    });
    const response = await createCanvasOAuthStartHandler(deps)(context(request));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/^https:\/\/canvas\.church\.example\/login\/oauth2\/auth\?/u);
    expect(deps.beginState).toHaveBeenCalledWith({}, {
      connectionId: 81, expectedRevision: 3, actorPersonId: 61,
      sessionBinding: 'session-binding', baseUrl: BASE_URL, clientId: 'canvas-client',
      redirectUri: 'https://church.test/admin/learning/canvas/callback',
      keyRing: { ring: true }, nowEpochMs: Date.parse('2026-08-17T12:00:00.000Z'),
    });
  });

  it('rejects cross-origin, malformed, and wrong-origin authorization without leaking diagnostics', async () => {
    const body = 'connection_id=81&revision=3&base_url=https%3A%2F%2Fcanvas.church.example';
    const cross = new Request('https://church.test/admin/learning/canvas/start', {
      method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    expect((await createCanvasOAuthStartHandler(startDeps())(context(cross))).status).toBe(403);
    const deps = startDeps();
    deps.beginState.mockResolvedValueOnce({
      authorizationUrl: 'https://evil.test/login/oauth2/auth', state: STATE, connectionRevision: 4,
    });
    const response = await createCanvasOAuthStartHandler(deps)(context(new Request('https://church.test/admin/learning/canvas/start', {
      method: 'POST', headers: { origin: 'https://church.test', 'content-type': 'application/x-www-form-urlencoded' }, body,
    })));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning?error=canvas_authorization_failed');
  });

  it('rejects an unallowlisted Canvas origin before creating OAuth state', async () => {
    const deps = { ...startDeps(), canvasAllowedOrigins: JSON.stringify(['https://other-canvas.example']) };
    const body = 'connection_id=81&revision=3&base_url=https%3A%2F%2Fcanvas.church.example';
    const request = new Request('https://church.test/admin/learning/canvas/start', {
      method: 'POST', headers: {
        origin: 'https://church.test', 'content-type': 'application/x-www-form-urlencoded',
      }, body,
    });
    const response = await createCanvasOAuthStartHandler(deps as never)(context(request));
    expect(response.headers.get('location')).toBe('/admin/learning?error=canvas_authorization_failed');
    expect(deps.beginState).not.toHaveBeenCalled();
  });

  it('claims one-time state, exchanges the code with PKCE, and CAS-completes the connection', async () => {
    const claim = {
      connectionId: 81, connectionRevision: 4, actorPersonId: 61,
      baseUrl: BASE_URL, redirectUri: 'https://church.test/admin/learning/canvas/callback',
      codeVerifier: 'v'.repeat(64), claimMarker: '10000000-0000-4000-8000-000000000001',
    };
    const credential = {
      version: 1 as const, accessToken: 'access', refreshToken: 'refresh',
      accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', grantedScopes: [] as never,
    };
    const deps = {
      appOrigin: 'https://church.test', clientId: 'canvas-client', clientSecret: 'canvas-secret', keySecret: 'key-secret',
      canvasAllowedOrigins: JSON.stringify([BASE_URL]),
      importKeyRing: vi.fn(async () => ({ ring: true })),
      claimState: vi.fn(async () => claim), exchangeCode: vi.fn(async () => credential),
      completeState: vi.fn(async () => undefined), now: vi.fn(() => Date.parse('2026-08-17T12:00:00.000Z')),
    };
    const request = new Request(`https://church.test/admin/learning/canvas/callback?code=one-time-code&state=${STATE}`);
    const response = await createCanvasOAuthCallbackHandler(deps)(context(request));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning?saved=canvas_connected');
    expect(deps.claimState).toHaveBeenCalledWith({}, expect.objectContaining({
      state: STATE, sessionBinding: 'session-binding', actorPersonId: 61,
      redirectUri: 'https://church.test/admin/learning/canvas/callback',
    }));
    expect(deps.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: BASE_URL, code: 'one-time-code', codeVerifier: 'v'.repeat(64),
      redirectUri: 'https://church.test/admin/learning/canvas/callback',
    }));
    expect(deps.completeState).toHaveBeenCalledWith({}, expect.objectContaining({ claim, credential }));
  });

  it('fails a callback if the deployment allowlist rotated after state claim, before token exchange', async () => {
    const claim = {
      connectionId: 81, connectionRevision: 4, actorPersonId: 61,
      baseUrl: BASE_URL, redirectUri: 'https://church.test/admin/learning/canvas/callback',
      codeVerifier: 'v'.repeat(64), claimMarker: '10000000-0000-4000-8000-000000000001',
    };
    const allowedOrigins = vi.fn()
      .mockReturnValueOnce(JSON.stringify([BASE_URL]))
      .mockReturnValue(JSON.stringify(['https://replacement-canvas.example']));
    const deps = {
      appOrigin: 'https://church.test', clientId: 'canvas-client', clientSecret: 'deployment-secret', keySecret: 'key-secret',
      canvasAllowedOrigins: allowedOrigins,
      importKeyRing: vi.fn(async () => ({ ring: true })), claimState: vi.fn(async () => claim),
      exchangeCode: vi.fn(), completeState: vi.fn(), now: vi.fn(() => Date.parse('2026-08-17T12:00:00.000Z')),
    };
    const request = new Request(`https://church.test/admin/learning/canvas/callback?code=one-time-code&state=${STATE}`);
    const response = await createCanvasOAuthCallbackHandler(deps as never)(context(request));
    expect(response.headers.get('location')).toBe('/admin/learning?error=canvas_authorization_failed');
    expect(allowedOrigins).toHaveBeenCalledTimes(2);
    expect(deps.claimState).toHaveBeenCalledTimes(1);
    expect(deps.exchangeCode).not.toHaveBeenCalled();
    expect(deps.completeState).not.toHaveBeenCalled();
  });

  it('fails closed for callback errors, duplicate parameters, missing session, or replay conflicts', async () => {
    const deps = {
      appOrigin: 'https://church.test', clientId: 'id', clientSecret: 'secret', keySecret: 'keys',
      canvasAllowedOrigins: JSON.stringify([BASE_URL]),
      importKeyRing: vi.fn(async () => ({})), claimState: vi.fn(async () => { throw new Error('replay'); }),
      exchangeCode: vi.fn(), completeState: vi.fn(), now: vi.fn(() => 1),
    };
    for (const search of [
      `?error=access_denied&state=${STATE}`,
      `?code=a&code=b&state=${STATE}`,
      '?code=a&state=short',
    ]) {
      const response = await createCanvasOAuthCallbackHandler(deps)(context(
        new Request(`https://church.test/admin/learning/canvas/callback${search}`),
      ));
      expect(response.headers.get('location')).toBe('/admin/learning?error=canvas_authorization_failed');
    }
  });
});
