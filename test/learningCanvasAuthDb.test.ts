import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  CANVAS_REQUIRED_SCOPES,
} from '../src/lib/learningCanvasProvider';
import {
  LearningCanvasAuthConflictError,
  LearningCanvasAuthError,
  beginCanvasOAuthState,
  claimCanvasOAuthState,
  completeCanvasOAuthState,
  loadCanvasCredential,
  rotateCanvasCredential,
} from '../src/lib/learningCanvasAuth';
import { importLearningCredentialKeyRing } from '../src/lib/learningCredentials';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const BASE_URL = 'https://canvas.church.example';
const REDIRECT = 'https://church.example.test/admin/learning/canvas/callback';
const SESSION = 'c4c_session=canvas-admin-session';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1,
  keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(18))) },
});

describe('Canvas OAuth one-time persistence and credential rotation', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id IN (28101,28102)').run();
    await env.DB.prepare('DELETE FROM people WHERE id=28100').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(28100,'Canvas Admin','canvas-admin@example.test')").run();
    for (const id of [28101, 28102]) await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(?1,'canvas','Canvas',?2,'pending',0,28100)`).bind(id, BASE_URL).run();
  });

  it('atomically starts one state per revision without persisting raw state, verifier, session, or client secret', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const start = () => beginCanvasOAuthState(env.DB as AppDb, {
      connectionId: 28101, expectedRevision: 0, actorPersonId: 28100,
      sessionBinding: SESSION, baseUrl: BASE_URL, clientId: 'client', redirectUri: REDIRECT,
      keyRing: ring, nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 7 : 9),
    });
    const settled = await Promise.allSettled([start(), start()]);
    expect(settled.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect((settled.find((value) => value.status === 'rejected') as PromiseRejectedResult).reason)
      .toBeInstanceOf(LearningCanvasAuthConflictError);
    const begun = (settled.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof start>>>).value;
    expect(begun.connectionRevision).toBe(1);
    const row = await env.DB.prepare(`SELECT state_hash,session_hash,verifier_ciphertext,redirect_uri,base_url,claim_marker
      FROM learning_canvas_oauth_states WHERE connection_id=28101`).first<Record<string, unknown>>();
    expect(row).toMatchObject({ redirect_uri: REDIRECT, base_url: BASE_URL, claim_marker: null });
    expect(JSON.stringify(row)).not.toContain(begun.state);
    expect(JSON.stringify(row)).not.toContain(SESSION);
    expect(JSON.stringify(row)).not.toContain('client');
  });

  it('binds callback to exact state, session, person, redirect, base URL and permits one claim', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const begun = await beginCanvasOAuthState(env.DB as AppDb, {
      connectionId: 28101, expectedRevision: 0, actorPersonId: 28100,
      sessionBinding: SESSION, baseUrl: BASE_URL, clientId: 'client', redirectUri: REDIRECT,
      keyRing: ring, nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 11 : 13),
    });
    await expect(claimCanvasOAuthState(env.DB as AppDb, {
      state: begun.state, sessionBinding: 'wrong-session', actorPersonId: 28100,
      redirectUri: REDIRECT, baseUrl: BASE_URL, keyRing: ring, nowEpochMs: NOW + 1,
    })).rejects.toBeInstanceOf(LearningCanvasAuthError);
    const claim = () => claimCanvasOAuthState(env.DB as AppDb, {
      state: begun.state, sessionBinding: SESSION, actorPersonId: 28100,
      redirectUri: REDIRECT, baseUrl: BASE_URL, keyRing: ring, nowEpochMs: NOW + 2,
    });
    const settled = await Promise.allSettled([claim(), claim()]);
    expect(settled.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const claimed = (settled.find((value) => value.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>>).value;
    expect(claimed).toMatchObject({
      connectionId: 28101, connectionRevision: 1, actorPersonId: 28100,
      redirectUri: REDIRECT, baseUrl: BASE_URL,
    });
    expect(claimed.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/u);
  });

  it('atomically activates, consumes state, encrypts tokens, and CAS-rotates one writer', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const begun = await beginCanvasOAuthState(env.DB as AppDb, {
      connectionId: 28102, expectedRevision: 0, actorPersonId: 28100,
      sessionBinding: SESSION, baseUrl: BASE_URL, clientId: 'client', redirectUri: REDIRECT,
      keyRing: ring, nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 17 : 19),
    });
    const claim = await claimCanvasOAuthState(env.DB as AppDb, {
      state: begun.state, sessionBinding: SESSION, actorPersonId: 28100,
      redirectUri: REDIRECT, baseUrl: BASE_URL, keyRing: ring, nowEpochMs: NOW + 1,
    });
    const credential = {
      version: 1 as const,
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      accessTokenExpiresAt: '2026-08-17T13:00:00.000Z',
      grantedScopes: CANVAS_REQUIRED_SCOPES,
    };
    expect(await completeCanvasOAuthState(env.DB as AppDb, {
      claim, credential, keyRing: ring, nowEpochMs: NOW + 2,
    })).toEqual({ connectionId: 28102, revision: 2, status: 'active' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM learning_canvas_oauth_states WHERE connection_id=28102').first('count')).toBe(0);
    const stored = await env.DB.prepare(`SELECT c.status,c.revision,p.ciphertext,p.nonce,p.expires_at
      FROM learning_provider_connections c JOIN learning_provider_credentials p ON p.connection_id=c.id
      WHERE c.id=28102`).first<Record<string, unknown>>();
    expect(stored).toMatchObject({ status: 'active', revision: 2, expires_at: null });
    expect(JSON.stringify(stored)).not.toMatch(/private-access|private-refresh/u);
    const loaded = await loadCanvasCredential(env.DB as AppDb, { connectionId: 28102, keyRing: ring });
    const rotate = () => rotateCanvasCredential(env.DB as AppDb, {
      connectionId: 28102,
      expectedRevision: loaded.revision,
      credential: { ...loaded.credential, accessToken: 'next-access', accessTokenExpiresAt: '2026-08-17T14:00:00.000Z' },
      keyRing: ring,
      nowEpochMs: NOW + 3,
    });
    const settled = await Promise.allSettled([rotate(), rotate()]);
    expect(settled.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((value) => value.status === 'rejected')).toHaveLength(1);
    expect((await loadCanvasCredential(env.DB as AppDb, { connectionId: 28102, keyRing: ring }))).toMatchObject({
      revision: 3,
      credential: { accessToken: 'next-access', refreshToken: 'private-refresh' },
    });
  });
});
