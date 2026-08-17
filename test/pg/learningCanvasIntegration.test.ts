import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  mapSelectedCanvasCourse,
  unmapSelectedCanvasCourse,
} from '../../src/lib/learningCanvasAdmin';
import {
  beginCanvasOAuthState,
  claimCanvasOAuthState,
  completeCanvasOAuthState,
} from '../../src/lib/learningCanvasAuth';
import {
  acceptCanvasLiveEvent,
  finishCanvasLiveEvent,
  type CanvasLiveEvent,
} from '../../src/lib/learningCanvasLiveEvents';
import { CANVAS_REQUIRED_SCOPES } from '../../src/lib/learningCanvasProvider';
import { importLearningCredentialKeyRing } from '../../src/lib/learningCredentials';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const BASE_URL = 'https://canvas-pg.church.example';
const REDIRECT = 'https://church.example.test/admin/learning/canvas/callback';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(83))) },
});

describe.skipIf(!hasPg)('Canvas OAuth, mapping, and Live Events parity (real Postgres)', () => {
  const sqlA = hasPg ? pgClient() : (null as never);
  const sqlB = hasPg ? pgClient() : (null as never);
  let dbA: AppDb;
  let dbB: AppDb;

  beforeAll(async () => {
    await resetSchema(sqlA);
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL }, encoding: 'utf8',
    });
    dbA = new PgAdapter(sqlA);
    dbB = new PgAdapter(sqlB);
    await sqlA.unsafe(`
      INSERT INTO people(id,display_name,email)
        VALUES(28401,'PG Canvas Admin','pg-canvas@example.test');
      INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id)
        VALUES(28402,'canvas','PG Canvas','${BASE_URL}','pending',0,28401);
      INSERT INTO learning_programs(id,slug,display_name)
        VALUES(28403,'pg-canvas','PG Canvas Program');
    `);
  });

  afterAll(async () => {
    await sqlB?.end();
    await sqlA?.end();
  });

  it('runs one-time OAuth, authoritative CAS mapping, concurrent receipt claim, and unmap', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const begun = await beginCanvasOAuthState(dbA, {
      connectionId: 28402, expectedRevision: 0, actorPersonId: 28401,
      sessionBinding: 'pg-canvas-session', baseUrl: BASE_URL, clientId: 'canvas-client',
      redirectUri: REDIRECT, keyRing, nowEpochMs: NOW,
      randomBytes: (size) => new Uint8Array(size).fill(size === 32 ? 91 : 92),
    });
    const claims = await Promise.allSettled([dbA, dbB].map((db) => claimCanvasOAuthState(db, {
      state: begun.state, sessionBinding: 'pg-canvas-session', actorPersonId: 28401,
      redirectUri: REDIRECT, baseUrl: BASE_URL, keyRing, nowEpochMs: NOW + 1,
    })));
    const winners = claims.filter((result) => result.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const claim = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimCanvasOAuthState>>>).value;
    await completeCanvasOAuthState(dbA, {
      claim,
      credential: {
        version: 1, accessToken: 'pg-canvas-access', refreshToken: 'pg-canvas-refresh',
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', grantedScopes: CANVAS_REQUIRED_SCOPES,
      },
      keyRing,
      nowEpochMs: NOW + 2,
    });
    const fetcher = vi.fn(async (raw: RequestInfo | URL) => {
      expect(new URL(String(raw)).pathname).toBe('/api/v1/courses/901');
      return new Response(JSON.stringify({
        id: 901, name: 'Genesis 1', workflow_state: 'available',
        created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-17T11:00:00.000Z',
      }));
    });
    const admin = {
      connectionId: 28402, clientId: 'canvas-client', clientSecret: 'canvas-secret',
      keyRing, fetcher: fetcher as typeof fetch, nowEpochMs: NOW + 3,
    };
    await expect(mapSelectedCanvasCourse(dbA, {
      ...admin, externalCourseId: '901', programId: 28403, actorPersonId: 28401,
      expectedRevision: 2, rootAccountId: 'pg-root-1',
    })).resolves.toMatchObject({ connectionRevision: 3, externalCourseId: '901' });

    const event: CanvasLiveEvent = Object.freeze({
      sourceEventId: `sha256:${'p'.repeat(43)}`,
      rootAccountId: 'pg-root-1', sourceHostname: 'canvas-pg.church.example',
      externalCourseId: '901', eventName: 'assignment_updated',
      eventTime: '2026-08-17T11:59:59.000Z', receivedAt: '2026-08-17T12:00:00.000Z',
    });
    const receipts = await Promise.all([
      acceptCanvasLiveEvent(dbA, event), acceptCanvasLiveEvent(dbB, event),
    ]);
    expect(receipts.filter((receipt) => receipt.disposition === 'claimed')).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.disposition === 'in_progress')).toHaveLength(1);
    const receipt = receipts.find((value) => value.disposition === 'claimed')!;
    await finishCanvasLiveEvent(dbA, {
      receipt, outcome: 'succeeded', completedAt: '2026-08-17T12:00:01.000Z',
    });
    await expect(unmapSelectedCanvasCourse(dbA, {
      ...admin, externalCourseId: '901', actorPersonId: 28401, expectedRevision: 3,
    })).resolves.toEqual({ connectionId: 28402, connectionRevision: 4 });
  });

  it('keeps every Canvas private-state table RLS-enabled and browser-role inaccessible', async () => {
    expect(await sqlA.unsafe(`SELECT relname,relrowsecurity FROM pg_class
      WHERE relname IN ('learning_canvas_oauth_states','learning_canvas_webhook_configs','learning_canvas_event_receipts')
      ORDER BY relname`)).toEqual([
      { relname: 'learning_canvas_event_receipts', relrowsecurity: true },
      { relname: 'learning_canvas_oauth_states', relrowsecurity: true },
      { relname: 'learning_canvas_webhook_configs', relrowsecurity: true },
    ]);
    expect(await sqlA.unsafe(`SELECT table_name,grantee,privilege_type
      FROM information_schema.table_privileges
      WHERE table_name LIKE 'learning_canvas_%' AND grantee IN ('PUBLIC','anon','authenticated')`)).toEqual([]);
    expect(await sqlA.unsafe(`SELECT column_name FROM information_schema.columns
      WHERE table_name='learning_canvas_event_receipts'
        AND column_name IN ('payload','body','grade','answer','comment','file_bytes')`)).toEqual([]);
  });
});
