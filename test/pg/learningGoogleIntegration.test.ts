import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../../src/lib/appDb';
import { encodeGoogleCredential, GOOGLE_CLASSROOM_SCOPES } from '../../src/lib/learningGoogleAuth';
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
        VALUES(27503,'pg-google','PG Google');
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
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: null,
    });
    await dbA.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27502,?1,?2,?3,?4,?5,NULL)`)
      .bind(envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion, envelope.envelopeVersion).run();
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
});
