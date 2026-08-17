import { describe, expect, it } from 'vitest';
import {
  GOOGLE_CLASSROOM_SCOPES,
  GOOGLE_OAUTH_STATE_TTL_MS,
  createGoogleOAuthAuthorizationRequest,
  decodeGoogleCredential,
  encodeGoogleCredential,
  normalizeGoogleTokenResponse,
} from '../src/lib/learningGoogleAuth';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const REDIRECT = 'https://church.example.test/admin/learning/google/callback';

describe('Google Classroom OAuth protocol', () => {
  it('uses only the five minimum read/notification scopes in canonical order', () => {
    expect(GOOGLE_CLASSROOM_SCOPES).toEqual([
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
      'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
      'https://www.googleapis.com/auth/classroom.push-notifications',
      'https://www.googleapis.com/auth/classroom.rosters.readonly',
    ]);
    expect(GOOGLE_CLASSROOM_SCOPES.join(' ')).not.toMatch(/profile|drive|\.students(?:\s|$)|\.rosters(?:\s|$)/u);
  });

  it('creates a short-lived one-time state and S256 PKCE request with an exact HTTPS redirect', async () => {
    const bytes = (size: number) => new Uint8Array(size).map((_, index) => (index * 13 + 7) & 0xff);
    const result = await createGoogleOAuthAuthorizationRequest({
      clientId: 'classroom-client.apps.googleusercontent.com',
      redirectUri: REDIRECT,
      nowEpochMs: NOW,
      randomBytes: bytes,
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'include_granted_scopes',
      'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
    ]);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CLASSROOM_SCOPES.join(' '));
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(result.state).not.toBe(result.codeVerifier);
    expect(result.stateHash).toBeInstanceOf(Uint8Array);
    expect(result.stateHash.byteLength).toBe(32);
    expect(result.expiresAt).toBe(new Date(NOW + GOOGLE_OAUTH_STATE_TTL_MS).toISOString());
    expect(result.authorizationUrl).not.toContain(result.codeVerifier);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects redirect aliases, credentials/fragments, weak randomness, and malformed client ids', async () => {
    const valid = {
      clientId: 'client.apps.googleusercontent.com', nowEpochMs: NOW,
      randomBytes: (size: number) => new Uint8Array(size).fill(5),
    };
    for (const redirectUri of [
      'http://church.example.test/admin/learning/google/callback',
      'https://church.example.test/admin/learning/google/callback/',
      'https://user@church.example.test/admin/learning/google/callback',
      'https://church.example.test/admin/learning/google/callback#fragment',
      'https://church.example.test/admin/learning/google/callback?next=/admin',
      'https://church.example.test/admin/learning/google/%63allback',
    ]) await expect(createGoogleOAuthAuthorizationRequest({ ...valid, redirectUri })).rejects.toThrow('learning_google_auth_invalid');
    await expect(createGoogleOAuthAuthorizationRequest({
      ...valid, redirectUri: REDIRECT, clientId: 'not-google-oauth',
    })).rejects.toThrow('learning_google_auth_invalid');
    await expect(createGoogleOAuthAuthorizationRequest({
      ...valid, redirectUri: REDIRECT, randomBytes: () => new Uint8Array(8),
    })).rejects.toThrow('learning_google_auth_invalid');
  });

  it('requires the granted scope set to match exactly and never accepts raw or grade carriers', () => {
    const base = {
      access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600,
      scope: GOOGLE_CLASSROOM_SCOPES.join(' '), token_type: 'Bearer',
    };
    const credential = normalizeGoogleTokenResponse(base, {
      nowEpochMs: NOW, requireRefreshToken: true, retainedRefreshToken: null,
    });
    expect(credential).toEqual({
      version: 1,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-17T13:00:00.000Z',
      grantedScopes: GOOGLE_CLASSROOM_SCOPES,
    });
    for (const response of [
      { ...base, scope: GOOGLE_CLASSROOM_SCOPES.slice(1).join(' ') },
      { ...base, scope: `${base.scope} https://www.googleapis.com/auth/drive.readonly` },
      { ...base, token_type: 'mac' },
      { ...base, raw: { access_token: 'access-token' } },
      { ...base, grade: 100 },
      { ...base, expires_in: 0 },
    ]) expect(() => normalizeGoogleTokenResponse(response, {
      nowEpochMs: NOW, requireRefreshToken: true, retainedRefreshToken: null,
    })).toThrow('learning_google_auth_invalid');
  });

  it('retains the prior refresh token when Google rotates only the access token', () => {
    const next = normalizeGoogleTokenResponse({
      access_token: 'next-access', expires_in: 1800,
      scope: [...GOOGLE_CLASSROOM_SCOPES].reverse().join(' '), token_type: 'Bearer',
    }, {
      nowEpochMs: NOW, requireRefreshToken: false, retainedRefreshToken: 'existing-refresh',
    });
    expect(next.refreshToken).toBe('existing-refresh');
    expect(next.accessTokenExpiresAt).toBe('2026-08-17T12:30:00.000Z');
    expect(next.grantedScopes).toEqual(GOOGLE_CLASSROOM_SCOPES);
  });

  it('derives a bounded refresh-token reconnect deadline and preserves it when omitted later', () => {
    const issuedOptions = {
      nowEpochMs: NOW, requireRefreshToken: true, retainedRefreshToken: null,
      retainedRefreshTokenExpiresAt: null,
    };
    const issued = normalizeGoogleTokenResponse({
      access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600,
      refresh_token_expires_in: 604_800,
      scope: GOOGLE_CLASSROOM_SCOPES.join(' '), token_type: 'Bearer',
    }, issuedOptions);
    expect(issued).toMatchObject({ refreshTokenExpiresAt: '2026-08-24T12:00:00.000Z' });
    const refreshed = normalizeGoogleTokenResponse({
      access_token: 'next-access', refresh_token: 'rotated-refresh', expires_in: 3600,
      scope: GOOGLE_CLASSROOM_SCOPES.join(' '), token_type: 'Bearer',
    }, {
      nowEpochMs: NOW + 1_000, requireRefreshToken: false, retainedRefreshToken: 'refresh-token',
      retainedRefreshTokenExpiresAt: '2026-08-24T12:00:00.000Z',
    });
    expect(refreshed).toMatchObject({
      refreshToken: 'rotated-refresh', refreshTokenExpiresAt: '2026-08-24T12:00:00.000Z',
    });
    for (const refresh_token_expires_in of [0, -1, 1.5, 316_224_001, Number.MAX_SAFE_INTEGER]) {
      expect(() => normalizeGoogleTokenResponse({
        access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600,
        refresh_token_expires_in, scope: GOOGLE_CLASSROOM_SCOPES.join(' '), token_type: 'Bearer',
      }, issuedOptions)).toThrow('learning_google_auth_invalid');
    }
  });

  it('serializes only the exact encrypted credential plaintext contract', () => {
    const credential = normalizeGoogleTokenResponse({
      access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600,
      scope: GOOGLE_CLASSROOM_SCOPES.join(' '), token_type: 'Bearer',
    }, { nowEpochMs: NOW, requireRefreshToken: true, retainedRefreshToken: null });
    const bytes = encodeGoogleCredential(credential);
    expect(new TextDecoder().decode(bytes)).not.toMatch(/grade|answer|comment|file/iu);
    expect(decodeGoogleCredential(bytes)).toEqual(credential);
    for (const plaintext of [
      '{}',
      JSON.stringify({ ...credential, raw: 'provider-response' }),
      JSON.stringify({ ...credential, grantedScopes: [...GOOGLE_CLASSROOM_SCOPES, 'extra'] }),
    ]) expect(() => decodeGoogleCredential(new TextEncoder().encode(plaintext)))
      .toThrow('learning_google_auth_invalid');
  });
});
