import { describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '../src/lib/types';
import { createGoogleOAuthStartHandler } from '../src/pages/admin/learning/google/start';
import { createGoogleOAuthCallbackHandler } from '../src/pages/admin/learning/google/callback';

const STATE = 's'.repeat(43);

function user(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 91, email: 'learning@example.test', displayName: 'Learning Admin', role: 'admin',
    isAdmin: true, isEditor: false, finance: 0, memberTeamIds: [], leaderTeamIds: [],
    lang: 'en', isSuperAdmin: false, adminAreas: ['learning'], ...over,
  };
}

function cookies(session: string | null = 'session-private') {
  return { get: vi.fn((name: string) => name === 'c4c_session' && session !== null ? { value: session } : undefined) };
}

function context(request: Request, options: {
  modules?: string[]; actor?: SessionUser | null; session?: string | null;
} = {}): never {
  return {
    request, url: new URL(request.url), cookies: cookies(options.session),
    locals: { modules: new Set(options.modules ?? ['learning']), user: options.actor === undefined ? user() : options.actor, db: {} },
  } as never;
}

const startDeps = () => ({
  appOrigin: 'https://church.test',
  clientId: 'client.apps.googleusercontent.com',
  keySecret: 'key-secret',
  importKeyRing: vi.fn(async () => ({ ring: true })),
  beginState: vi.fn(async () => ({
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${STATE}`,
    state: STATE, connectionRevision: 4,
  })),
  now: vi.fn(() => Date.parse('2026-08-17T12:00:00.000Z')),
});

const callbackDeps = () => ({
  appOrigin: 'https://church.test',
  clientId: 'client.apps.googleusercontent.com',
  clientSecret: 'private-client-secret',
  keySecret: 'key-secret',
  importKeyRing: vi.fn(async () => ({ ring: true })),
  claimState: vi.fn(async () => ({
    connectionId: 73, connectionRevision: 4, actorPersonId: 91,
    redirectUri: 'https://church.test/admin/learning/google/callback',
    codeVerifier: 'v'.repeat(64), claimMarker: '123e4567-e89b-42d3-a456-426614174000',
  })),
  exchangeCode: vi.fn(async () => ({
    version: 1 as const, accessToken: 'private-access', refreshToken: 'private-refresh',
    accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', grantedScopes: Object.freeze([
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
      'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
      'https://www.googleapis.com/auth/classroom.push-notifications',
      'https://www.googleapis.com/auth/classroom.rosters.readonly',
    ] as const),
  })),
  completeState: vi.fn(async () => ({ connectionId: 73, revision: 5, status: 'active' as const })),
  now: vi.fn(() => Date.parse('2026-08-17T12:00:00.000Z')),
});

describe('Google OAuth admin start route', () => {
  it('checks module, Learning area, method, and CSRF before body/database/secrets', async () => {
    let pulled = false;
    const request = new Request('https://church.test/admin/learning/google/start', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new ReadableStream({ pull() { pulled = true; throw new Error('body read'); } }, { highWaterMark: 0 }),
    });
    const injected = startDeps();
    expect((await createGoogleOAuthStartHandler(injected)(context(request, { modules: [] }))).status).toBe(404);
    expect((await createGoogleOAuthStartHandler(injected)(context(request, { actor: user({ adminAreas: [] }) }))).status).toBe(403);
    expect((await createGoogleOAuthStartHandler(injected)(context(request))).status).toBe(403);
    expect(pulled).toBe(false);
    expect(injected.importKeyRing).not.toHaveBeenCalled();
  });

  it('starts one exact revision-bound state and redirects only to Google authorization', async () => {
    const injected = startDeps();
    const request = new Request('https://church.test/admin/learning/google/start', {
      method: 'POST', headers: {
        'content-type': 'application/x-www-form-urlencoded', origin: 'https://church.test',
      }, body: 'connection_id=73&revision=3',
    });
    const response = await createGoogleOAuthStartHandler(injected)(context(request));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`https://accounts.google.com/o/oauth2/v2/auth?state=${STATE}`);
    expect(injected.beginState).toHaveBeenCalledWith({}, expect.objectContaining({
      connectionId: 73, expectedRevision: 3, actorPersonId: 91,
      sessionBinding: 'session-private', clientId: 'client.apps.googleusercontent.com',
      redirectUri: 'https://church.test/admin/learning/google/callback', keyRing: { ring: true },
    }));
  });
});

describe('Google OAuth admin callback route', () => {
  it('claims state, exchanges the exact code+verifier, and atomically completes before safe redirect', async () => {
    const injected = callbackDeps();
    const request = new Request(`https://church.test/admin/learning/google/callback?code=one-time-code&state=${STATE}`);
    const response = await createGoogleOAuthCallbackHandler(injected)(context(request));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/admin/learning?saved=google_connected');
    expect(injected.claimState).toHaveBeenCalledWith({}, expect.objectContaining({
      state: STATE, sessionBinding: 'session-private', actorPersonId: 91,
      redirectUri: 'https://church.test/admin/learning/google/callback',
    }));
    expect(injected.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({
      code: 'one-time-code', codeVerifier: 'v'.repeat(64), redirectUri: 'https://church.test/admin/learning/google/callback',
      clientSecret: 'private-client-secret',
    }));
    expect(injected.completeState).toHaveBeenCalledWith({}, expect.objectContaining({
      claim: expect.objectContaining({ connectionId: 73 }),
      credential: expect.objectContaining({ refreshToken: 'private-refresh' }),
    }));
  });

  it('rejects query aliases/replay safely without leaking code, state, verifier, or token', async () => {
    const injected = callbackDeps();
    injected.claimState.mockRejectedValueOnce(new Error('private-state private verifier'));
    for (const search of [
      `?code=one-time-code&state=${STATE}&extra=1`,
      `?code=one-time-code&state=${STATE}`,
    ]) {
      const response = await createGoogleOAuthCallbackHandler(injected)(context(
        new Request(`https://church.test/admin/learning/google/callback${search}`),
      ));
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/admin/learning?error=google_authorization_failed');
      expect(response.headers.get('location')).not.toMatch(/one-time|private|verifier|token/iu);
    }
  });
});
