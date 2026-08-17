import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_CLASSROOM_SCOPES,
  exchangeGoogleAuthorizationCode,
  refreshGoogleAccessToken,
  revokeGoogleRefreshToken,
} from '../src/lib/learningGoogleAuth';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const REDIRECT = 'https://church.example.test/admin/learning/google/callback';
const SCOPE = GOOGLE_CLASSROOM_SCOPES.join(' ');

function tokenResponse(refreshToken?: string): Response {
  return new Response(JSON.stringify({
    access_token: 'access-new', expires_in: 3600,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    scope: SCOPE, token_type: 'Bearer',
  }), { headers: { 'content-type': 'application/json' } });
}

describe('Google OAuth token and revocation HTTP boundary', () => {
  it('exchanges an exact one-time code with PKCE on the official token endpoint', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body.entries())).toEqual({
        client_id: 'client.apps.googleusercontent.com', client_secret: 'private-client-secret',
        code: 'one-time-code', code_verifier: 'v'.repeat(64), grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
      });
      return tokenResponse('refresh-new');
    });
    await expect(exchangeGoogleAuthorizationCode({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      code: 'one-time-code', codeVerifier: 'v'.repeat(64), redirectUri: REDIRECT,
      fetcher, signal: new AbortController().signal, nowEpochMs: NOW,
    })).resolves.toMatchObject({
      accessToken: 'access-new', refreshToken: 'refresh-new',
      accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', grantedScopes: GOOGLE_CLASSROOM_SCOPES,
    });
  });

  it('refreshes on the official endpoint and retains the old refresh token when Google does not rotate it', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)).entries())).toEqual({
        client_id: 'client.apps.googleusercontent.com', client_secret: 'private-client-secret',
        grant_type: 'refresh_token', refresh_token: 'refresh-old',
      });
      return tokenResponse();
    });
    await expect(refreshGoogleAccessToken({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      refreshToken: 'refresh-old', fetcher, signal: new AbortController().signal, nowEpochMs: NOW,
    })).resolves.toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-old' });
  });

  it('revokes only at the official endpoint and never puts the refresh token in the URL', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/revoke');
      expect(String(input)).not.toContain('refresh-private');
      expect(String(init?.body)).toBe('token=refresh-private');
      return new Response(null, { status: 200 });
    });
    await expect(revokeGoogleRefreshToken({
      refreshToken: 'refresh-private', fetcher, signal: new AbortController().signal,
    })).resolves.toBeUndefined();
  });

  it('rejects non-exact scopes and oversized/malformed upstream responses without leaking provider details', async () => {
    const wrongScope = GOOGLE_CLASSROOM_SCOPES.slice(0, -1).join(' ');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'private-access', expires_in: 3600, refresh_token: 'private-refresh',
      scope: wrongScope, token_type: 'Bearer',
    })));
    const error = await exchangeGoogleAuthorizationCode({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      code: 'one-time-code', codeVerifier: 'v'.repeat(64), redirectUri: REDIRECT,
      fetcher, signal: new AbortController().signal, nowEpochMs: NOW,
    }).catch((value: unknown) => value);
    expect(String(error)).not.toMatch(/private-access|private-refresh|private-client-secret/iu);
    await expect(exchangeGoogleAuthorizationCode({
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      code: 'one-time-code', codeVerifier: 'v'.repeat(64), redirectUri: REDIRECT,
      fetcher: async () => new Response(new Uint8Array(65_537), { headers: { 'content-length': '65537' } }),
      signal: new AbortController().signal, nowEpochMs: NOW,
    })).rejects.toThrow('learning_google_auth_invalid');
  });
});
