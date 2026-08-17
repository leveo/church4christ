import { describe, expect, it, vi } from 'vitest';
import { CANVAS_REQUIRED_SCOPES } from '../src/lib/learningCanvasProvider';
import {
  CANVAS_OAUTH_STATE_TTL_MS,
  createCanvasOAuthAuthorizationRequest,
  decodeCanvasCredential,
  encodeCanvasCredential,
  exchangeCanvasAuthorizationCode,
  normalizeCanvasTokenResponse,
  refreshCanvasAccessToken,
  revokeCanvasAccessToken,
} from '../src/lib/learningCanvasAuth';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const BASE_URL = 'https://canvas.church.example';
const REDIRECT = 'https://church.example.test/admin/learning/canvas/callback';

describe('Canvas OAuth protocol', () => {
  it('builds exact-origin authorization-code OAuth with S256 PKCE and minimum URL scopes', async () => {
    const result = await createCanvasOAuthAuthorizationRequest({
      baseUrl: BASE_URL,
      clientId: 'canvas-client-id',
      redirectUri: REDIRECT,
      nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).map((_, index) => (index * 17 + 3) & 0xff),
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${BASE_URL}/login/oauth2/auth`);
    expect([...url.searchParams.keys()].sort()).toEqual([
      'client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri',
      'response_type', 'scope', 'state',
    ]);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe(CANVAS_REQUIRED_SCOPES.join(' '));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(result.authorizationUrl).not.toContain(result.codeVerifier);
    expect(result.stateHash).toBeInstanceOf(Uint8Array);
    expect(result.stateHash.byteLength).toBe(32);
    expect(result.expiresAt).toBe(new Date(NOW + CANVAS_OAUTH_STATE_TTL_MS).toISOString());
  });

  it('rejects base/redirect aliases, credentials, fragments, query strings, and weak randomness', async () => {
    const valid = {
      baseUrl: BASE_URL, clientId: 'canvas-client-id', redirectUri: REDIRECT, nowEpochMs: NOW,
      randomBytes: (size: number) => new Uint8Array(size).fill(7),
    };
    for (const input of [
      { ...valid, baseUrl: `${BASE_URL}/canvas` },
      { ...valid, baseUrl: 'https://user@canvas.church.example' },
      { ...valid, redirectUri: `${REDIRECT}/` },
      { ...valid, redirectUri: `${REDIRECT}?next=/admin` },
      { ...valid, redirectUri: `${REDIRECT}#fragment` },
      { ...valid, randomBytes: () => new Uint8Array(8) },
    ]) await expect(createCanvasOAuthAuthorizationRequest(input)).rejects.toThrow('learning_canvas_auth_invalid');
  });

  it('normalizes and serializes only exact token fields and canonical requested scopes', () => {
    const credential = normalizeCanvasTokenResponse({
      access_token: 'canvas-access',
      refresh_token: 'canvas-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: [...CANVAS_REQUIRED_SCOPES].reverse().join(' '),
      canvas_region: 'unknown',
      user: { id: 91, name: 'not persisted' },
    }, { nowEpochMs: NOW, requireRefreshToken: true, retainedRefreshToken: null });
    expect(credential).toEqual({
      version: 1,
      accessToken: 'canvas-access',
      refreshToken: 'canvas-refresh',
      accessTokenExpiresAt: '2026-08-17T13:00:00.000Z',
      grantedScopes: CANVAS_REQUIRED_SCOPES,
    });
    const bytes = encodeCanvasCredential(credential);
    expect(decodeCanvasCredential(bytes)).toEqual(credential);
    expect(new TextDecoder().decode(bytes)).not.toMatch(/name|email|grade|answer|comment|file/iu);
    for (const response of [
      { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'mac' },
      { access_token: 'a', refresh_token: 'r', expires_in: 0, token_type: 'Bearer' },
      { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', raw: {} },
      { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'Bearer', scope: CANVAS_REQUIRED_SCOPES.slice(1).join(' ') },
    ]) expect(() => normalizeCanvasTokenResponse(response, {
      nowEpochMs: NOW, requireRefreshToken: true, retainedRefreshToken: null,
    })).toThrow('learning_canvas_auth_invalid');
  });

  it('exchanges and refreshes only at the exact Canvas token endpoint with bounded manual redirects', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(`${BASE_URL}/login/oauth2/token`);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code') {
        expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
        expect(body.get('redirect_uri')).toBe(REDIRECT);
        return new Response(JSON.stringify({
          access_token: 'access-one', refresh_token: 'refresh-one', expires_in: 3600, token_type: 'Bearer',
        }), { headers: { 'content-type': 'application/json' } });
      }
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('refresh-one');
      return new Response(JSON.stringify({ access_token: 'access-two', expires_in: 3600, token_type: 'Bearer' }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const exchanged = await exchangeCanvasAuthorizationCode({
      baseUrl: BASE_URL, clientId: 'client', clientSecret: 'secret', code: 'one-time-code',
      codeVerifier: 'a'.repeat(64), redirectUri: REDIRECT, fetcher,
      signal: new AbortController().signal, nowEpochMs: NOW,
    });
    const refreshed = await refreshCanvasAccessToken({
      baseUrl: BASE_URL, clientId: 'client', clientSecret: 'secret', refreshToken: exchanged.refreshToken,
      fetcher, signal: new AbortController().signal, nowEpochMs: NOW + 1_000,
    });
    expect(refreshed).toMatchObject({ accessToken: 'access-two', refreshToken: 'refresh-one' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('revokes by authenticated DELETE and never places the token in URL/body', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).toBe(`${BASE_URL}/login/oauth2/token`);
      expect(init?.method).toBe('DELETE');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer canvas-access');
      expect(init?.redirect).toBe('manual');
      return new Response(null, { status: 204 });
    });
    await revokeCanvasAccessToken({
      baseUrl: BASE_URL, accessToken: 'canvas-access', fetcher,
      signal: new AbortController().signal,
    });
  });
});
