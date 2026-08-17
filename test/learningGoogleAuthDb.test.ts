import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  LearningGoogleAuthConflictError,
  LearningGoogleAuthError,
  beginGoogleOAuthState,
  claimGoogleOAuthState,
  completeGoogleOAuthState,
  loadGoogleCredential,
  rotateGoogleCredential,
} from '../src/lib/learningGoogleAuth';
import { importLearningCredentialKeyRing } from '../src/lib/learningCredentials';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const REDIRECT = 'https://church.example.test/admin/learning/google/callback';
const SESSION = 'c4c_session=session-one';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1,
  keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(8))) },
});

describe('Google OAuth one-time persistence and rotation', () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM learning_provider_connections WHERE id IN (27001,27002)").run();
    await env.DB.prepare("DELETE FROM people WHERE id=27000").run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27000,'OAuth Admin','oauth-admin@example.test')").run();
    for (const id of [27001, 27002]) await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(?1,'google_classroom','Classroom',NULL,'pending',0,27000)`).bind(id).run();
  });

  it('atomically starts one state per expected revision without persisting raw state, verifier, or session', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const start = () => beginGoogleOAuthState(env.DB as AppDb, {
      connectionId: 27001,
      expectedRevision: 0,
      actorPersonId: 27000,
      sessionBinding: SESSION,
      clientId: 'client.apps.googleusercontent.com',
      redirectUri: REDIRECT,
      keyRing: ring,
      nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 7 : 9),
    });
    const settled = await Promise.allSettled([start(), start()]);
    expect(settled.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const failure = settled.find((value) => value.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(LearningGoogleAuthConflictError);
    const begun = (settled.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof start>>>).value;
    expect(begun.connectionRevision).toBe(1);
    expect(Object.keys(begun).sort()).toEqual(['authorizationUrl', 'connectionRevision', 'state']);
    const row = await env.DB.prepare(`SELECT state_hash,session_hash,verifier_ciphertext,redirect_uri,
      claim_marker FROM learning_google_oauth_states WHERE connection_id=27001`).first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(begun.state);
    expect(JSON.stringify(row)).not.toContain(SESSION);
    expect(row?.redirect_uri).toBe(REDIRECT);
    expect(row?.claim_marker).toBeNull();
  });

  it('binds state to the exact admin session/person/redirect and lets only one callback claim it', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const begun = await beginGoogleOAuthState(env.DB as AppDb, {
      connectionId: 27001, expectedRevision: 0, actorPersonId: 27000,
      sessionBinding: SESSION, clientId: 'client.apps.googleusercontent.com',
      redirectUri: REDIRECT, keyRing: ring, nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 11 : 13),
    });
    await expect(claimGoogleOAuthState(env.DB as AppDb, {
      state: begun.state, sessionBinding: 'c4c_session=different', actorPersonId: 27000,
      redirectUri: REDIRECT, keyRing: ring, nowEpochMs: NOW + 1,
    })).rejects.toBeInstanceOf(LearningGoogleAuthError);
    const claim = () => claimGoogleOAuthState(env.DB as AppDb, {
      state: begun.state, sessionBinding: SESSION, actorPersonId: 27000,
      redirectUri: REDIRECT, keyRing: ring, nowEpochMs: NOW + 2,
    });
    const settled = await Promise.allSettled([claim(), claim()]);
    expect(settled.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((value) => value.status === 'rejected')).toHaveLength(1);
    const claimed = (settled.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>>).value;
    expect(claimed).toMatchObject({
      connectionId: 27001, connectionRevision: 1, actorPersonId: 27000,
      redirectUri: REDIRECT,
    });
    expect(claimed.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(claimed.claimMarker).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('atomically activates the connection, consumes state, and stores only an AES token envelope', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const begun = await beginGoogleOAuthState(env.DB as AppDb, {
      connectionId: 27001, expectedRevision: 0, actorPersonId: 27000,
      sessionBinding: SESSION, clientId: 'client.apps.googleusercontent.com',
      redirectUri: REDIRECT, keyRing: ring, nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 17 : 19),
    });
    const claim = await claimGoogleOAuthState(env.DB as AppDb, {
      state: begun.state, sessionBinding: SESSION, actorPersonId: 27000,
      redirectUri: REDIRECT, keyRing: ring, nowEpochMs: NOW + 1,
    });
    const credential = {
      version: 1 as const,
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      accessTokenExpiresAt: '2026-08-17T13:00:00.000Z',
      grantedScopes: (await import('../src/lib/learningGoogleAuth')).GOOGLE_CLASSROOM_SCOPES,
    };
    const completed = await completeGoogleOAuthState(env.DB as AppDb, {
      claim, credential, keyRing: ring, nowEpochMs: NOW + 2,
    });
    expect(completed).toEqual({ connectionId: 27001, revision: 2, status: 'active' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM learning_google_oauth_states WHERE connection_id=27001').first('count')).toBe(0);
    const stored = await env.DB.prepare(`SELECT c.status,c.revision,p.ciphertext,p.nonce
      FROM learning_provider_connections c JOIN learning_provider_credentials p ON p.connection_id=c.id
      WHERE c.id=27001`).first<Record<string, unknown>>();
    expect(stored).toMatchObject({ status: 'active', revision: 2 });
    expect(JSON.stringify(stored)).not.toMatch(/private-access|private-refresh/u);
    expect(await loadGoogleCredential(env.DB as AppDb, {
      connectionId: 27001, keyRing: ring,
    })).toEqual({ connectionId: 27001, revision: 2, credential });
    await expect(completeGoogleOAuthState(env.DB as AppDb, {
      claim, credential, keyRing: ring, nowEpochMs: NOW + 3,
    })).rejects.toBeInstanceOf(LearningGoogleAuthConflictError);
  });

  it('CAS-rotates access credentials, preserves refresh token, and rejects stale concurrent writers', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const first = await beginGoogleOAuthState(env.DB as AppDb, {
      connectionId: 27002, expectedRevision: 0, actorPersonId: 27000,
      sessionBinding: SESSION, clientId: 'client.apps.googleusercontent.com',
      redirectUri: REDIRECT, keyRing: ring, nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 21 : 23),
    });
    const claim = await claimGoogleOAuthState(env.DB as AppDb, {
      state: first.state, sessionBinding: SESSION, actorPersonId: 27000,
      redirectUri: REDIRECT, keyRing: ring, nowEpochMs: NOW + 1,
    });
    await completeGoogleOAuthState(env.DB as AppDb, {
      claim, keyRing: ring, nowEpochMs: NOW + 2,
      credential: {
        version: 1, accessToken: 'old-access', refreshToken: 'old-refresh',
        accessTokenExpiresAt: '2026-08-17T12:05:00.000Z',
        grantedScopes: (await import('../src/lib/learningGoogleAuth')).GOOGLE_CLASSROOM_SCOPES,
      },
    });
    const loaded = await loadGoogleCredential(env.DB as AppDb, { connectionId: 27002, keyRing: ring });
    const nextCredential = { ...loaded.credential, accessToken: 'new-access', accessTokenExpiresAt: '2026-08-17T13:00:00.000Z' };
    const rotate = () => rotateGoogleCredential(env.DB as AppDb, {
      connectionId: 27002, expectedRevision: loaded.revision, credential: nextCredential,
      keyRing: ring, nowEpochMs: NOW + 3,
    });
    const settled = await Promise.allSettled([rotate(), rotate()]);
    expect(settled.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((value) => value.status === 'rejected')).toHaveLength(1);
    const after = await loadGoogleCredential(env.DB as AppDb, { connectionId: 27002, keyRing: ring });
    expect(after.revision).toBe(3);
    expect(after.credential).toMatchObject({ accessToken: 'new-access', refreshToken: 'old-refresh' });
  });
});
