import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb, AppDbResult, AppStatement } from '../src/lib/appDb';
import {
  listGoogleClassroomCourseOptions,
  mapSelectedGoogleClassroomCourse,
  unmapSelectedGoogleClassroomCourse,
} from '../src/lib/learningGoogleAdmin';
import { encodeGoogleCredential, GOOGLE_CLASSROOM_SCOPES } from '../src/lib/learningGoogleAuth';
import {
  googleClassroomPushReadiness,
  renewGoogleClassroomRegistrations,
} from '../src/lib/learningGoogleRegistrationLifecycle';
import {
  listGoogleClassroomCleanupConnectionIds,
  recoverGoogleClassroomCleanup,
} from '../src/lib/learningGoogleCleanup';
import { runGoogleClassroomRegistrationRenewalPass } from '../src/lib/learningGoogleRegistrationCron';
import {
  encryptLearningCredential,
  importLearningCredentialKeyRing,
} from '../src/lib/learningCredentials';
import { clearModuleCache } from '../src/lib/modules';
import { setSetting } from '../src/lib/settings';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const TOPIC = 'projects/church-project/topics/classroom';
const SUBSCRIPTION = 'projects/church-project/subscriptions/classroom';
const SERVICE_ACCOUNT = 'classroom-push@church-project.iam.gserviceaccount.com';
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(44))) },
});

async function seedGraph(): Promise<Awaited<ReturnType<typeof importLearningCredentialKeyRing>>> {
  await env.DB.prepare('DELETE FROM learning_courses WHERE connection_id=27602').run();
  await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=27602').run();
  await env.DB.prepare('DELETE FROM learning_programs WHERE id IN (27603,27604)').run();
  await env.DB.prepare('DELETE FROM people WHERE id=27601').run();
  await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27601,'Lifecycle Admin','lifecycle@example.test')").run();
  await env.DB.prepare(`INSERT INTO learning_provider_connections
    (id,provider,display_name,base_url,status,revision,created_by_person_id)
    VALUES(27602,'google_classroom','Classroom',NULL,'active',1,27601)`).run();
  await env.DB.prepare(`INSERT INTO learning_programs(id,slug,display_name,status,created_by_person_id) VALUES
    (27603,'lifecycle-one','Lifecycle One','active',27601),
    (27604,'lifecycle-two','Lifecycle Two','active',27601)`).run();
  const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
  const envelope = await encryptLearningCredential(keyRing, {
    provider: 'google_classroom', connectionId: 27602,
    plaintext: encodeGoogleCredential({
      version: 1, accessToken: 'private-access', refreshToken: 'private-refresh',
      accessTokenExpiresAt: '2026-08-17T13:00:00.000Z',
      refreshTokenExpiresAt: '2026-09-17T12:00:00.000Z',
      grantedScopes: GOOGLE_CLASSROOM_SCOPES,
    }), expiresAt: '2026-09-17T12:00:00.000Z',
  });
  await env.DB.prepare(`INSERT INTO learning_provider_credentials
    (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
    VALUES(27602,?1,?2,?3,?4,?5,?6)`)
    .bind(
      envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion,
      envelope.envelopeVersion, envelope.expiresAt,
    ).run();
  return keyRing;
}

function providerCourse(): Record<string, unknown> {
  return {
    id: 'course-1', name: 'Genesis 1', courseState: 'ACTIVE',
    alternateLink: 'https://classroom.google.com/c/course-1',
    updateTime: '2026-08-17T11:00:00.000Z',
  };
}

function registrationFetcher(prefix: string, expectedTopic = TOPIC) {
  let created = 0;
  const deleted: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/courses/course-1') return new Response(JSON.stringify(providerCourse()));
    if (url.pathname === '/v1/registrations' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, Record<string, unknown>>;
      expect(body.cloudPubsubTopic).toEqual({ topicName: expectedTopic });
      expect(['COURSE_ROSTER_CHANGES', 'COURSE_WORK_CHANGES']).toContain(body.feed?.feedType);
      created += 1;
      return new Response(JSON.stringify({
        registrationId: `${prefix}-${created}`,
        expiryTime: '2026-08-24T12:00:00.000Z',
      }));
    }
    if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
      deleted.push(decodeURIComponent(url.pathname.slice('/v1/registrations/'.length)));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected Google request ${init?.method ?? 'GET'} ${url.pathname}`);
  });
  return { fetcher, deleted };
}

describe('Google Classroom push readiness', () => {
  it('distinguishes an intentionally polling-only deployment from complete and partial push bindings', () => {
    expect(googleClassroomPushReadiness({
      topicName: undefined, subscriptionName: undefined, serviceAccountEmail: undefined,
    })).toEqual({ mode: 'polling_only', topicName: null });
    expect(googleClassroomPushReadiness({
      topicName: TOPIC, subscriptionName: SUBSCRIPTION, serviceAccountEmail: SERVICE_ACCOUNT,
    })).toEqual({ mode: 'ready', topicName: TOPIC });
    expect(googleClassroomPushReadiness({
      topicName: TOPIC, subscriptionName: undefined, serviceAccountEmail: SERVICE_ACCOUNT,
    })).toEqual({ mode: 'misconfigured', topicName: null });
    expect(googleClassroomPushReadiness({
      topicName: 'https://attacker.test/topic', subscriptionName: SUBSCRIPTION,
      serviceAccountEmail: SERVICE_ACCOUNT,
    })).toEqual({ mode: 'misconfigured', topicName: null });
  });
});

describe('Google Classroom mapped-course registration lifecycle (D1)', () => {
  beforeEach(seedGraph);

  it('CAS maps/remaps one authoritative course with both official feeds and removes replaced registrations', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const first = registrationFetcher('first');
    const common = {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing, nowEpochMs: NOW,
    };
    await expect(mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, fetcher: first.fetcher, expectedRevision: 1, externalCourseId: 'course-1',
      programId: 27603, actorPersonId: 27601, pushTopicName: TOPIC,
    })).resolves.toMatchObject({ programId: 27603, externalCourseId: 'course-1' });
    expect(first.deleted).toEqual([]);
    expect(await env.DB.prepare(`SELECT feed_type,registration_id FROM learning_google_registrations
      WHERE connection_id=27602 ORDER BY feed_type`).all()).toMatchObject({ results: [
      { feed_type: 'COURSE_ROSTER_CHANGES', registration_id: 'first-1' },
      { feed_type: 'COURSE_WORK_CHANGES', registration_id: 'first-2' },
    ] });

    const second = registrationFetcher('second');
    await expect(mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, fetcher: second.fetcher, expectedRevision: 2, externalCourseId: 'course-1',
      programId: 27604, actorPersonId: 27601, pushTopicName: TOPIC,
    })).resolves.toMatchObject({ programId: 27604, externalCourseId: 'course-1' });
    expect(second.deleted.sort()).toEqual(['first-1', 'first-2']);
    expect(await env.DB.prepare(`SELECT c.program_id,p.revision FROM learning_courses c
      JOIN learning_provider_connections p ON p.id=c.connection_id
      WHERE c.connection_id=27602 AND c.external_course_id='course-1'`).first()).toEqual({
      program_id: 27604, revision: 3,
    });
    expect(await env.DB.prepare(`SELECT feed_type,registration_id FROM learning_google_registrations
      WHERE connection_id=27602 ORDER BY feed_type`).all()).toMatchObject({ results: [
      { feed_type: 'COURSE_ROSTER_CHANGES', registration_id: 'second-1' },
      { feed_type: 'COURSE_WORK_CHANGES', registration_id: 'second-2' },
    ] });
  });

  it('has one exact-revision winner and deletes the losing writer registrations', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const one = registrationFetcher('race-one');
    const two = registrationFetcher('race-two');
    const base = {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, nowEpochMs: NOW, expectedRevision: 1, externalCourseId: 'course-1',
      actorPersonId: 27601, pushTopicName: TOPIC,
    };
    const settled = await Promise.allSettled([
      mapSelectedGoogleClassroomCourse(env.DB as AppDb, { ...base, fetcher: one.fetcher, programId: 27603 }),
      mapSelectedGoogleClassroomCourse(env.DB as AppDb, { ...base, fetcher: two.fetcher, programId: 27604 }),
    ]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect([...one.deleted, ...two.deleted]).toHaveLength(2);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_google_registrations
      WHERE connection_id=27602`).first()).toEqual({ count: 2 });
  });

  it('commits the remap and durably retries prior cleanup when remote deletion fails', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const first = registrationFetcher('prior');
    const common = {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing, nowEpochMs: NOW,
    };
    await mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, fetcher: first.fetcher, expectedRevision: 1, externalCourseId: 'course-1',
      programId: 27603, actorPersonId: 27601, pushTopicName: TOPIC,
    });
    let created = 0;
    const attemptedDeletes: string[] = [];
    const failingFetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.pathname === '/v1/courses/course-1') return new Response(JSON.stringify(providerCourse()));
      if (url.pathname === '/v1/registrations' && init?.method === 'POST') {
        created += 1;
        return new Response(JSON.stringify({
          registrationId: `replacement-${created}`,
          expiryTime: '2026-08-24T12:00:00.000Z',
        }));
      }
      if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
        const id = decodeURIComponent(url.pathname.slice('/v1/registrations/'.length));
        attemptedDeletes.push(id);
        return id.startsWith('prior-')
          ? new Response(null, { status: 503 })
          : new Response(null, { status: 200 });
      }
      throw new Error(`unexpected Google request ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    await expect(mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, fetcher: failingFetcher, expectedRevision: 2, externalCourseId: 'course-1',
      programId: 27604, actorPersonId: 27601, pushTopicName: TOPIC,
    })).resolves.toMatchObject({ programId: 27604 });
    expect(attemptedDeletes).toEqual(['prior-1']);
    expect(await env.DB.prepare(`SELECT c.program_id,p.revision FROM learning_courses c
      JOIN learning_provider_connections p ON p.id=c.connection_id
      WHERE c.connection_id=27602 AND c.external_course_id='course-1'`).first()).toEqual({
      program_id: 27604, revision: 3,
    });
    expect(await env.DB.prepare(`SELECT registration_id FROM learning_google_registrations
      WHERE connection_id=27602 ORDER BY feed_type`).all()).toMatchObject({
      results: [{ registration_id: 'replacement-1' }, { registration_id: 'replacement-2' }],
    });
    expect(await env.DB.prepare(`SELECT registration_id,task_type FROM learning_google_cleanup_tasks
      WHERE connection_id=27602 ORDER BY registration_id`).all()).toMatchObject({ results: [
      { registration_id: 'prior-1', task_type: 'registration' },
      { registration_id: 'prior-2', task_type: 'registration' },
    ] });
  });

  it('lets only the remap CAS winner enqueue and delete prior authoritative registrations', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const initial = registrationFetcher('authoritative');
    const common = {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing, nowEpochMs: NOW,
      externalCourseId: 'course-1', actorPersonId: 27601, pushTopicName: TOPIC,
    };
    await mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, fetcher: initial.fetcher, expectedRevision: 1, programId: 27603,
    });
    let sequence = 0;
    const deleted: string[] = [];
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.pathname === '/v1/courses/course-1') return new Response(JSON.stringify(providerCourse()));
      if (url.pathname === '/v1/registrations' && init?.method === 'POST') {
        sequence += 1;
        return new Response(JSON.stringify({
          registrationId: `contest-${sequence}`, expiryTime: '2026-08-24T12:00:00.000Z',
        }));
      }
      if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
        deleted.push(decodeURIComponent(url.pathname.slice('/v1/registrations/'.length)));
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected Google request ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    const settled = await Promise.allSettled([
      mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
        ...common, fetcher, expectedRevision: 2, programId: 27603,
      }),
      mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
        ...common, fetcher, expectedRevision: 2, programId: 27604,
      }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(deleted.filter((id) => id === 'authoritative-1')).toHaveLength(1);
    expect(deleted.filter((id) => id === 'authoritative-2')).toHaveLength(1);
    expect(deleted.filter((id) => id.startsWith('contest-'))).toHaveLength(2);
  });

  it('unmaps with exact revision, deletes both remote registrations, and soft-deletes the local course', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const requests = registrationFetcher('unmap');
    const common = {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing, fetcher: requests.fetcher, nowEpochMs: NOW,
    };
    await mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, expectedRevision: 1, externalCourseId: 'course-1', programId: 27603,
      actorPersonId: 27601, pushTopicName: TOPIC,
    });
    await expect(unmapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, expectedRevision: 2, externalCourseId: 'course-1', actorPersonId: 27601,
    })).resolves.toMatchObject({ connectionId: 27602, connectionRevision: 3 });
    expect(requests.deleted.sort()).toEqual(['unmap-1', 'unmap-2']);
    expect(await env.DB.prepare(`SELECT lifecycle_state,deleted_at FROM learning_courses
      WHERE connection_id=27602 AND external_course_id='course-1'`).first()).toEqual({
      lifecycle_state: 'deleted', deleted_at: expect.any(String),
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_google_registrations
      WHERE connection_id=27602`).first()).toEqual({ count: 0 });
  });

  it('commits the unmap and durably retries cleanup when remote deletion fails', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const initial = registrationFetcher('retryable');
    const common = {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing, nowEpochMs: NOW,
    };
    await mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, fetcher: initial.fetcher, expectedRevision: 1, externalCourseId: 'course-1',
      programId: 27603, actorPersonId: 27601, pushTopicName: TOPIC,
    });
    const attemptedDeletes: string[] = [];
    const failingFetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
        attemptedDeletes.push(decodeURIComponent(url.pathname.slice('/v1/registrations/'.length)));
        return new Response(null, { status: 503 });
      }
      throw new Error(`unexpected Google request ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    await expect(unmapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, fetcher: failingFetcher, expectedRevision: 2,
      externalCourseId: 'course-1', actorPersonId: 27601,
    })).resolves.toMatchObject({ connectionId: 27602, connectionRevision: 3 });
    expect(attemptedDeletes).toEqual(['retryable-1']);
    expect(await env.DB.prepare(`SELECT c.lifecycle_state,c.deleted_at,p.revision FROM learning_courses c
      JOIN learning_provider_connections p ON p.id=c.connection_id
      WHERE c.connection_id=27602 AND c.external_course_id='course-1'`).first()).toEqual({
      lifecycle_state: 'deleted', deleted_at: expect.any(String), revision: 3,
    });
    expect(await env.DB.prepare(`SELECT registration_id FROM learning_google_registrations
      WHERE connection_id=27602 ORDER BY feed_type`).all()).toMatchObject({
      results: [],
    });
    expect(await env.DB.prepare(`SELECT registration_id FROM learning_google_cleanup_tasks
      WHERE connection_id=27602 ORDER BY registration_id`).all()).toMatchObject({
      results: [{ registration_id: 'retryable-1' }, { registration_id: 'retryable-2' }],
    });
  });

  it('stays under the D1 50-query and 50-bind-per-statement budgets', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const requests = registrationFetcher('budget');
    let queries = 0;
    let maxBinds = 0;
    const wrapped: AppDb = {
      prepare(sql: string): AppStatement {
        queries += 1;
        const statement = (env.DB as AppDb).prepare(sql);
        return {
          bind(...values: unknown[]) { maxBinds = Math.max(maxBinds, values.length); return statement.bind(...values); },
          first: <T>(column?: string) => statement.first<T>(column),
          all: <T>() => statement.all<T>(),
          run: <T>() => statement.run<T>(),
        };
      },
      batch: <T>(statements: AppStatement[]) => (env.DB as AppDb).batch<T>(statements),
    };
    await mapSelectedGoogleClassroomCourse(wrapped, {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing, fetcher: requests.fetcher, nowEpochMs: NOW,
      expectedRevision: 1, externalCourseId: 'course-1', programId: 27603,
      actorPersonId: 27601, pushTopicName: TOPIC,
    });
    expect(queries).toBeLessThanOrEqual(50);
    expect(maxBinds).toBeLessThanOrEqual(50);
  });

  it('lists the CAS revision and encrypted refresh-token reconnect deadline without token material', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ courses: [providerCourse()] })));
    const options = await listGoogleClassroomCourseOptions(env.DB as AppDb, {
      connectionId: 27602, clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher, nowEpochMs: NOW,
    });
    expect(options).toMatchObject({
      connectionRevision: 1,
      reconnectDeadline: '2026-09-17T12:00:00.000Z',
    });
    expect(JSON.stringify(options)).not.toMatch(/private-access|private-refresh|private-client-secret/iu);
  });
});

describe('Google Classroom bounded registration renewal (D1)', () => {
  beforeEach(async () => {
    await seedGraph();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(27605,27603,27602,'google_classroom','course-1','Genesis 1',
        'https://classroom.google.com/c/course-1')`).run();
    await env.DB.prepare(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time) VALUES
      (27602,'course-1','COURSE_ROSTER_CHANGES','old-roster',?1,'2026-08-18T12:00:00.000Z'),
      (27602,'course-1','COURSE_WORK_CHANGES','old-work',?1,'2026-08-18T12:00:00.000Z')`)
      .bind(TOPIC).run();
  });

  it('renews both feeds before expiry with registration-id CAS and removes the replaced remote IDs', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const requests = registrationFetcher('renewed');
    await expect(renewGoogleClassroomRegistrations(env.DB as AppDb, {
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher: requests.fetcher, nowEpochMs: NOW, topicName: TOPIC,
      signal: new AbortController().signal,
    })).resolves.toEqual({ selected: 2, renewed: 2, conflicted: 0, failed: 0 });
    expect(requests.deleted.sort()).toEqual(['old-roster', 'old-work']);
    expect(await env.DB.prepare(`SELECT registration_id FROM learning_google_registrations
      WHERE connection_id=27602 ORDER BY feed_type`).all()).toMatchObject({
      results: [{ registration_id: 'renewed-1' }, { registration_id: 'renewed-2' }],
    });
  });

  it('does not renew an otherwise-due registration from a previous topic binding', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const replacementTopic = 'projects/church-project/topics/replacement';
    const requests = registrationFetcher('retargeted', replacementTopic);
    await expect(renewGoogleClassroomRegistrations(env.DB as AppDb, {
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher: requests.fetcher, nowEpochMs: NOW,
      topicName: replacementTopic,
      signal: new AbortController().signal,
    })).resolves.toEqual({ selected: 2, renewed: 2, conflicted: 0, failed: 0 });
    expect(await env.DB.prepare(`SELECT topic_name FROM learning_google_registrations
      WHERE connection_id=27602 ORDER BY feed_type`).all()).toMatchObject({
      results: [{ topic_name: replacementTopic }, { topic_name: replacementTopic }],
    });
  });

  it('recovers registrations that have already expired instead of dropping them from renewal', async () => {
    await env.DB.prepare(`UPDATE learning_google_registrations
      SET expiry_time='2026-08-17T11:59:59.000Z' WHERE connection_id=27602`).run();
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const requests = registrationFetcher('recovered');
    await expect(renewGoogleClassroomRegistrations(env.DB as AppDb, {
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher: requests.fetcher, nowEpochMs: NOW, topicName: TOPIC,
      signal: new AbortController().signal,
    })).resolves.toEqual({ selected: 2, renewed: 2, conflicted: 0, failed: 0 });
  });

  it('keeps failed old-registration cleanup in the durable outbox after renewal wins', async () => {
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const requests = registrationFetcher('durable-renewal');
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.pathname.startsWith('/v1/registrations/') && init?.method === 'DELETE') {
        return new Response(null, { status: 503 });
      }
      return requests.fetcher(request, init);
    });
    await expect(renewGoogleClassroomRegistrations(env.DB as AppDb, {
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher, nowEpochMs: NOW, topicName: TOPIC,
      signal: new AbortController().signal,
    })).resolves.toEqual({ selected: 2, renewed: 2, conflicted: 0, failed: 0 });
    expect(await env.DB.prepare(`SELECT registration_id FROM learning_google_cleanup_tasks
      WHERE connection_id=27602 ORDER BY registration_id`).all()).toMatchObject({
      results: [{ registration_id: 'old-roster' }, { registration_id: 'old-work' }],
    });
  });

  it('drains eight feeds twice hourly within the complete production D1 query budget', async () => {
    for (let course = 2; course <= 6; course += 1) {
      await env.DB.prepare(`INSERT INTO learning_courses
        (program_id,connection_id,provider,external_course_id,display_name,launch_url)
        VALUES(27603,27602,'google_classroom',?1,?2,?3)`)
        .bind(`course-${course}`, `Course ${course}`, `https://classroom.google.com/c/course-${course}`).run();
      await env.DB.prepare(`INSERT INTO learning_google_registrations
        (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time) VALUES
        (27602,?1,'COURSE_ROSTER_CHANGES',?2,?4,'2026-08-18T12:00:00.000Z'),
        (27602,?1,'COURSE_WORK_CHANGES',?3,?4,'2026-08-18T12:00:00.000Z')`)
        .bind(`course-${course}`, `old-${course}-roster`, `old-${course}-work`, TOPIC).run();
    }
    let queries = 0;
    let maxBinds = 0;
    const wrapped: AppDb = {
      prepare(sql: string): AppStatement {
        queries += 1;
        const statement = (env.DB as AppDb).prepare(sql);
        return {
          bind(...values: unknown[]) { maxBinds = Math.max(maxBinds, values.length); return statement.bind(...values); },
          first: <T>(column?: string) => statement.first<T>(column),
          all: <T>() => statement.all<T>(),
          run: <T>() => statement.run<T>(),
        };
      },
      batch: <T>(statements: AppStatement[]) => (env.DB as AppDb).batch<T>(statements),
    };
    const keyRing = await importLearningCredentialKeyRing(KEY_SECRET);
    const requests = registrationFetcher('capacity');
    await expect(renewGoogleClassroomRegistrations(wrapped, {
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing, fetcher: requests.fetcher, nowEpochMs: NOW, topicName: TOPIC,
      signal: new AbortController().signal,
    })).resolves.toEqual({ selected: 8, renewed: 8, conflicted: 0, failed: 0 });
    // The production cron adds one fresh module-gate query and one durable
    // cleanup-connection lookup before calling this function.
    expect(queries + 2).toBeLessThanOrEqual(50);
    expect(maxBinds).toBeLessThanOrEqual(100);
    expect(8 * 2 * 24 * 7).toBeGreaterThanOrEqual(2_000);
  });

  it('reserves cleanup fairly while renewing expired, due, and topic-mismatched feeds within complete cron budgets', async () => {
    await setSetting(env.DB, 'module.learning', '1');
    clearModuleCache();
    for (let course = 2; course <= 4; course += 1) {
      await env.DB.prepare(`INSERT INTO learning_courses
        (program_id,connection_id,provider,external_course_id,display_name,launch_url)
        VALUES(27603,27602,'google_classroom',?1,?2,?3)`)
        .bind(`course-${course}`, `Course ${course}`, `https://classroom.google.com/c/course-${course}`).run();
      const expiry = course === 2 ? '2026-08-17T11:59:59.000Z' : '2026-08-18T12:00:00.000Z';
      const topic = course === 3 ? 'projects/church-project/topics/removed' : TOPIC;
      await env.DB.prepare(`INSERT INTO learning_google_registrations
        (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time) VALUES
        (27602,?1,'COURSE_ROSTER_CHANGES',?2,?4,?5),
        (27602,?1,'COURSE_WORK_CHANGES',?3,?4,?5)`)
        .bind(`course-${course}`, `old-${course}-roster`, `old-${course}-work`, topic, expiry).run();
    }
    await env.DB.prepare(`INSERT INTO learning_google_cleanup_tasks
      (connection_id,task_type,registration_id) VALUES(27602,'registration','persistently-failing')`).run();

    let queries = 0;
    let maxBinds = 0;
    const wrapped: AppDb = {
      prepare(sql: string): AppStatement {
        queries += 1;
        const statement = (env.DB as AppDb).prepare(sql);
        return {
          bind(...values: unknown[]) { maxBinds = Math.max(maxBinds, values.length); return statement.bind(...values); },
          first: <T>(column?: string) => statement.first<T>(column),
          all: <T>() => statement.all<T>(),
          run: <T>() => statement.run<T>(),
        };
      },
      batch: <T>(statements: AppStatement[]) => (env.DB as AppDb).batch<T>(statements),
    };
    const requests = registrationFetcher('fair');
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.pathname === '/v1/registrations/persistently-failing' && init?.method === 'DELETE') {
        return new Response(null, { status: 503 });
      }
      return requests.fetcher(request, init);
    });
    await expect(runGoogleClassroomRegistrationRenewalPass({
      DB_BACKEND: 'd1',
      GOOGLE_CLASSROOM_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_CLASSROOM_CLIENT_SECRET: 'private-client-secret',
      GOOGLE_CLASSROOM_PUBSUB_TOPIC: TOPIC,
      GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL: SERVICE_ACCOUNT,
      GOOGLE_PUBSUB_SUBSCRIPTION_NAME: SUBSCRIPTION,
      LEARNING_CREDENTIAL_KEYS: KEY_SECRET,
    }, wrapped, {
      fetcher, now: () => NOW, importKeyRing: importLearningCredentialKeyRing,
      renew: renewGoogleClassroomRegistrations,
      listCleanupConnectionIds: listGoogleClassroomCleanupConnectionIds,
      recoverCleanup: recoverGoogleClassroomCleanup,
    })).resolves.toEqual({
      status: 'completed', summary: { selected: 8, renewed: 8, conflicted: 0, failed: 0 },
    });
    expect(queries).toBe(40);
    expect(queries).toBeLessThanOrEqual(50);
    expect(maxBinds).toBeLessThanOrEqual(100);
    // One failing reserved cleanup plus create/delete for each renewed feed.
    expect(fetcher).toHaveBeenCalledTimes(17);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(20);
  });
});
