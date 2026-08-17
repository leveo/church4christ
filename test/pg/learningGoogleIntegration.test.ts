import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import {
  checkGoogleClassroomConnectionHealth,
  disconnectGoogleClassroomConnection,
  mapSelectedGoogleClassroomCourse,
  unmapSelectedGoogleClassroomCourse,
} from '../../src/lib/learningGoogleAdmin';
import {
  encodeGoogleCredential,
  GOOGLE_CLASSROOM_SCOPES,
  loadGoogleCredentialForAdmin,
} from '../../src/lib/learningGoogleAuth';
import { renewGoogleClassroomRegistrations } from '../../src/lib/learningGoogleRegistrationLifecycle';
import {
  acceptGooglePubSubDelivery,
  finishGooglePubSubDelivery,
  type GooglePubSubDelivery,
} from '../../src/lib/learningGooglePubSub';
import { reconcileGoogleClassroomCourse } from '../../src/lib/learningGoogleReconcile';
import {
  encryptLearningCredential,
  importLearningCredentialKeyRing,
} from '../../src/lib/learningCredentials';
import { PgAdapter } from '../../src/lib/pgAdapter';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const SUBSCRIPTION = 'projects/church-project/subscriptions/classroom';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(30))) },
});

function delivery(receivedAt = '2026-08-17T12:00:00.000Z'): GooglePubSubDelivery {
  return Object.freeze({
    subscriptionName: SUBSCRIPTION,
    messageId: 'pg-message-1',
    registrationId: 'pg-registration-work',
    collection: 'courses.courseWork',
    externalCourseId: 'course-1',
    resourceId: Object.freeze({ courseId: 'course-1', id: 'work-1' }),
    publishedAt: '2026-08-17T11:59:59.000Z',
    receivedAt,
  });
}

function rotatedTokenResponse(accessToken: string, refreshToken: string): Response {
  return new Response(JSON.stringify({
    access_token: accessToken, expires_in: 3_600,
    refresh_token: refreshToken, refresh_token_expires_in: 604_800,
    scope: GOOGLE_CLASSROOM_SCOPES.join(' '), token_type: 'Bearer',
  }), { headers: { 'content-type': 'application/json' } });
}

describe.skipIf(!hasPg)('Google Classroom receipt and reconciliation parity (real Postgres)', () => {
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
        VALUES(27501,'PG Google Admin','pg-google@example.test');
      INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id)
        VALUES(27502,'google_classroom','Classroom',NULL,'active',1,27501);
      INSERT INTO learning_programs(id,slug,display_name)
        VALUES(27503,'pg-google','PG Google'),(27513,'pg-google-lifecycle','PG Google Lifecycle');
      INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id)
        VALUES(27512,'google_classroom','Lifecycle Classroom',NULL,'active',1,27501);
      INSERT INTO learning_courses
        (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
        VALUES(27504,27503,27502,'google_classroom','course-1','Old title',
          'https://classroom.google.com/c/course-1');
      INSERT INTO learning_google_registrations
        (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
        VALUES(27502,'course-1','COURSE_WORK_CHANGES','pg-registration-work',
          'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z');
    `);
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(ring, {
      provider: 'google_classroom', connectionId: 27502,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'private-access', refreshToken: 'private-refresh',
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', refreshTokenExpiresAt: null,
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: null,
    });
    await dbA.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27502,?1,?2,?3,?4,?5,NULL)`)
      .bind(envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion, envelope.envelopeVersion).run();
    const lifecycleEnvelope = await encryptLearningCredential(ring, {
      provider: 'google_classroom', connectionId: 27512,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'lifecycle-access', refreshToken: 'lifecycle-refresh',
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', refreshTokenExpiresAt: null,
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: null,
    });
    await dbA.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27512,?1,?2,?3,?4,?5,NULL)`)
      .bind(
        lifecycleEnvelope.ciphertext, lifecycleEnvelope.nonce, lifecycleEnvelope.algorithm,
        lifecycleEnvelope.keyVersion, lifecycleEnvelope.envelopeVersion,
      ).run();
  });

  afterAll(async () => {
    await sqlB?.end();
    await sqlA?.end();
  });

  it('has server-only 0021 columns and one concurrent receipt claim', async () => {
    expect(await sqlA.unsafe(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='learning_google_notification_receipts'
        AND column_name IN ('status','attempt_count','claim_marker','claim_expires_at','completed_at')
      ORDER BY column_name`)).toEqual([
      { column_name: 'attempt_count' }, { column_name: 'claim_expires_at' },
      { column_name: 'claim_marker' }, { column_name: 'completed_at' }, { column_name: 'status' },
    ]);
    const calls = await Promise.all([
      acceptGooglePubSubDelivery(dbA, delivery()),
      acceptGooglePubSubDelivery(dbB, delivery()),
    ]);
    expect(calls.filter((value) => value.disposition === 'claimed')).toHaveLength(1);
    expect(calls.filter((value) => value.disposition === 'in_progress')).toHaveLength(1);
    const claimed = calls.find((value) => value.disposition === 'claimed')!;
    await finishGooglePubSubDelivery(dbA, {
      receipt: claimed, outcome: 'succeeded', completedAt: '2026-08-17T12:00:10.000Z',
    });
    await expect(acceptGooglePubSubDelivery(dbB, delivery('2026-08-17T12:00:11.000Z')))
      .resolves.toMatchObject({ disposition: 'succeeded', attemptCount: 1 });
    expect((await sqlA.unsafe(`SELECT relrowsecurity FROM pg_class
      WHERE relname='learning_google_notification_receipts'`))[0]).toEqual({ relrowsecurity: true });
    expect((await sqlA.unsafe(`SELECT relrowsecurity FROM pg_class
      WHERE relname='learning_google_cleanup_tasks'`))[0]).toEqual({ relrowsecurity: true });
  });

  it('runs the same bounded authoritative notification sync through PgAdapter', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/courses/course-1') return new Response(JSON.stringify({
        id: 'course-1', name: 'Genesis 1', courseState: 'ACTIVE',
        alternateLink: 'https://classroom.google.com/c/course-1',
        updateTime: '2026-08-17T11:55:00.000Z',
      }));
      if (
        path.endsWith('/teachers') || path.endsWith('/students')
        || path.endsWith('/courseWorkMaterials') || path.endsWith('/courseWork')
      ) return new Response('{}');
      throw new Error(`unexpected ${path}`);
    });
    await expect(reconcileGoogleClassroomCourse(dbA, {
      connectionId: 27502, externalCourseId: 'course-1', trigger: 'notification',
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, now: () => NOW, signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect((await sqlA.unsafe(`SELECT display_name,last_synced_at FROM learning_courses WHERE id=27504`))[0])
      .toEqual({ display_name: 'Genesis 1', last_synced_at: '2026-08-17T12:00:00.000Z' });
  });

  it('persists a complete rotated error-health credential with exact Postgres CAS parity', async () => {
    await sqlA.unsafe(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(27532,'google_classroom','PG Error Health',NULL,'error',1,27501)`);
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(ring, {
      provider: 'google_classroom', connectionId: 27532,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'pg-expired-access', refreshToken: 'pg-old-refresh',
        accessTokenExpiresAt: '2026-08-17T11:00:00.000Z',
        refreshTokenExpiresAt: '2026-08-20T12:00:00.000Z',
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: '2026-08-20T12:00:00.000Z',
    });
    await dbA.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27532,?1,?2,?3,?4,?5,?6)`).bind(
      envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion,
      envelope.envelopeVersion, envelope.expiresAt,
    ).run();
    let refreshCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.toString() === 'https://oauth2.googleapis.com/token') {
        refreshCalls += 1;
        expect(new URLSearchParams(String(init?.body)).get('refresh_token')).toBe('pg-old-refresh');
        if (refreshCalls > 1) throw new Error('stale PG refresh token reused');
        return rotatedTokenResponse('pg-rotated-access', 'pg-rotated-refresh');
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer pg-rotated-access');
      return new Response(null, { status: 200 });
    });
    const input = {
      connectionId: 27532, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing: ring, fetcher, nowEpochMs: NOW,
    };
    await expect(checkGoogleClassroomConnectionHealth(dbA, input))
      .resolves.toEqual({ ok: true, errorCode: null, connectionRevision: 2 });
    await expect(checkGoogleClassroomConnectionHealth(dbA, input))
      .resolves.toEqual({ ok: true, errorCode: null, connectionRevision: 2 });
    await expect(loadGoogleCredentialForAdmin(dbA, { connectionId: 27532, keyRing: ring }))
      .resolves.toMatchObject({
        revision: 2, status: 'error',
        credential: {
          accessToken: 'pg-rotated-access', refreshToken: 'pg-rotated-refresh',
          refreshTokenExpiresAt: '2026-08-24T12:00:00.000Z',
        },
      });
    expect(refreshCalls).toBe(1);
  });

  it('has one exact-revision mapping winner with two feeds and cleans the losing registrations', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    let sequence = 0;
    const deleted: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/courses/course-lifecycle') return new Response(JSON.stringify({
        id: 'course-lifecycle', name: 'Lifecycle course', courseState: 'ACTIVE',
        alternateLink: 'https://classroom.google.com/c/course-lifecycle',
        updateTime: '2026-08-17T11:55:00.000Z',
      }));
      if (url.pathname === '/v1/registrations' && init?.method === 'POST') {
        sequence += 1;
        return new Response(JSON.stringify({
          registrationId: `pg-lifecycle-${sequence}`,
          expiryTime: '2026-08-24T12:00:00.000Z',
        }));
      }
      if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
        deleted.push(decodeURIComponent(url.pathname.slice('/v1/registrations/'.length)));
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const common = {
      connectionId: 27512, expectedRevision: 1, externalCourseId: 'course-lifecycle',
      programId: 27513, actorPersonId: 27501, pushTopicName: 'projects/church-project/topics/classroom',
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
    };
    const settled = await Promise.allSettled([
      mapSelectedGoogleClassroomCourse(dbA, common),
      mapSelectedGoogleClassroomCourse(dbB, common),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await sqlA.unsafe(`SELECT revision FROM learning_provider_connections WHERE id=27512`))
      .toEqual([{ revision: 2 }]);
    expect(await sqlA.unsafe(`SELECT feed_type FROM learning_google_registrations
      WHERE connection_id=27512 ORDER BY feed_type`)).toEqual([
      { feed_type: 'COURSE_ROSTER_CHANGES' }, { feed_type: 'COURSE_WORK_CHANGES' },
    ]);
    expect(deleted).toHaveLength(2);
  });

  it('keeps Postgres remap and unmap cleanup durable when remote deletion fails', async () => {
    await sqlA.unsafe(`
      INSERT INTO learning_programs(id,slug,display_name)
        VALUES(27523,'pg-google-cleanup','PG Google Cleanup');
      INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id)
        VALUES(27522,'google_classroom','Cleanup Classroom',NULL,'active',1,27501);
    `);
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(ring, {
      provider: 'google_classroom', connectionId: 27522,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'cleanup-access', refreshToken: 'cleanup-refresh',
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', refreshTokenExpiresAt: null,
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: null,
    });
    await dbA.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27522,?1,?2,?3,?4,?5,NULL)`)
      .bind(envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion, envelope.envelopeVersion).run();
    let sequence = 0;
    let failPriorCleanup = false;
    const priorIds = new Set<string>();
    const attemptedDeletes: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/courses/course-cleanup') return new Response(JSON.stringify({
        id: 'course-cleanup', name: 'Cleanup course', courseState: 'ACTIVE',
        alternateLink: 'https://classroom.google.com/c/course-cleanup',
        updateTime: '2026-08-17T11:55:00.000Z',
      }));
      if (url.pathname === '/v1/registrations' && init?.method === 'POST') {
        sequence += 1;
        const registrationId = sequence <= 2 ? `pg-prior-${sequence}` : `pg-replacement-${sequence}`;
        if (sequence <= 2) priorIds.add(registrationId);
        return new Response(JSON.stringify({
          registrationId, expiryTime: '2026-08-24T12:00:00.000Z',
        }));
      }
      if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
        const registrationId = decodeURIComponent(url.pathname.slice('/v1/registrations/'.length));
        attemptedDeletes.push(registrationId);
        return failPriorCleanup && priorIds.has(registrationId)
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const common = {
      connectionId: 27522, externalCourseId: 'course-cleanup', actorPersonId: 27501,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
    };
    await mapSelectedGoogleClassroomCourse(dbA, {
      ...common, expectedRevision: 1, programId: 27523,
      pushTopicName: 'projects/church-project/topics/classroom',
    });
    failPriorCleanup = true;
    await expect(mapSelectedGoogleClassroomCourse(dbA, {
      ...common, expectedRevision: 2, programId: 27523,
      pushTopicName: 'projects/church-project/topics/classroom',
    })).resolves.toMatchObject({ programId: 27523 });
    expect(attemptedDeletes).toEqual(expect.arrayContaining(['pg-prior-1']));
    expect(await sqlA.unsafe(`SELECT revision FROM learning_provider_connections WHERE id=27522`))
      .toEqual([{ revision: 3 }]);
    expect(await sqlA.unsafe(`SELECT registration_id FROM learning_google_registrations
      WHERE connection_id=27522 ORDER BY feed_type`)).toEqual([
      { registration_id: 'pg-replacement-3' }, { registration_id: 'pg-replacement-4' },
    ]);
    expect(await sqlA.unsafe(`SELECT registration_id FROM learning_google_cleanup_tasks
      WHERE connection_id=27522 AND task_type='registration' ORDER BY registration_id`)).toEqual([
      { registration_id: 'pg-prior-1' }, { registration_id: 'pg-prior-2' },
    ]);
    attemptedDeletes.length = 0;
    await expect(unmapSelectedGoogleClassroomCourse(dbA, {
      ...common, expectedRevision: 3,
    })).resolves.toMatchObject({ connectionId: 27522, connectionRevision: 4 });
    expect(attemptedDeletes).toEqual(['pg-replacement-3', 'pg-replacement-4']);
    expect(await sqlA.unsafe(`SELECT lifecycle_state,deleted_at FROM learning_courses
      WHERE connection_id=27522 AND external_course_id='course-cleanup'`)).toEqual([
      { lifecycle_state: 'deleted', deleted_at: expect.any(String) },
    ]);
  });

  it('CAS-renews both feeds under concurrent Postgres drains and disconnects through the durable saga', async () => {
    await sqlA.unsafe(`UPDATE learning_google_registrations
      SET expiry_time='2026-08-18T12:00:00.000Z' WHERE connection_id=27512`);
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    let sequence = 0;
    const deleted: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/registrations' && init?.method === 'POST') {
        sequence += 1;
        return new Response(JSON.stringify({
          registrationId: `pg-renewed-${sequence}`,
          expiryTime: '2026-08-24T12:00:00.000Z',
        }));
      }
      if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
        deleted.push(decodeURIComponent(url.pathname.slice('/v1/registrations/'.length)));
        return new Response(null, { status: 200 });
      }
      if (url.toString() === 'https://oauth2.googleapis.com/revoke') {
        expect(String(init?.body)).toBe('token=lifecycle-refresh');
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const renewInput = {
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
      topicName: 'projects/church-project/topics/classroom', signal: new AbortController().signal,
    };
    const drains = await Promise.all([
      renewGoogleClassroomRegistrations(dbA, renewInput),
      renewGoogleClassroomRegistrations(dbB, renewInput),
    ]);
    expect(drains.reduce((sum, result) => sum + result.renewed, 0)).toBe(2);
    expect(drains.reduce((sum, result) => sum + result.conflicted, 0)).toBe(2);
    expect(await sqlA.unsafe(`SELECT registration_id FROM learning_google_registrations
      WHERE connection_id=27512 ORDER BY feed_type`)).toEqual([
      { registration_id: expect.stringMatching(/^pg-renewed-/u) },
      { registration_id: expect.stringMatching(/^pg-renewed-/u) },
    ]);
    await expect(disconnectGoogleClassroomConnection(dbA, {
      connectionId: 27512, expectedRevision: 2, actorPersonId: 27501,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
    })).resolves.toMatchObject({ status: 'disabled', revision: 3 });
    expect(await sqlA.unsafe(`SELECT
      (SELECT COUNT(*)::int FROM learning_google_registrations WHERE connection_id=27512) AS registrations,
      (SELECT COUNT(*)::int FROM learning_provider_credentials WHERE connection_id=27512) AS credentials`))
      .toEqual([{ registrations: 0, credentials: 0 }]);
    expect(deleted.length).toBeGreaterThanOrEqual(6);
  });
});
