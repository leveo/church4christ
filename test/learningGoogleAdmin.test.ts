import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  checkGoogleClassroomConnectionHealth,
  disconnectGoogleClassroomConnection,
  listGoogleClassroomCourseOptions,
  mapSelectedGoogleClassroomCourse,
} from '../src/lib/learningGoogleAdmin';
import { LearningConnectionConflictError, getLearningConnection } from '../src/lib/learningConnectionDb';
import { encodeGoogleCredential, GOOGLE_CLASSROOM_SCOPES } from '../src/lib/learningGoogleAuth';
import {
  encryptLearningCredential,
  importLearningCredentialKeyRing,
} from '../src/lib/learningCredentials';
import { recoverGoogleClassroomCleanup } from '../src/lib/learningGoogleCleanup';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(28))) },
});

describe('Google Classroom admin authoritative course selection', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM learning_courses WHERE connection_id=27302').run();
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=27302').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id=27303').run();
    await env.DB.prepare('DELETE FROM people WHERE id=27301').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27301,'Course Admin','course-admin@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(27302,'google_classroom','Classroom',NULL,'active',1,27301)`).run();
    await env.DB.prepare(`INSERT INTO learning_programs
      (id,slug,display_name,status,created_by_person_id)
      VALUES(27303,'sunday-school','Sunday School','active',27301)`).run();
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(ring, {
      provider: 'google_classroom', connectionId: 27302,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'private-access', refreshToken: 'private-refresh',
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', refreshTokenExpiresAt: null,
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: null,
    });
    await env.DB.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27302,?1,?2,?3,?4,?5,NULL)`)
      .bind(envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion, envelope.envelopeVersion).run();
  });

  it('lists bounded course metadata, maps by authoritative courses.get, and never sends token data to persistence', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const course = {
        id: 'course-1', name: 'Genesis 1', courseState: 'ACTIVE',
        alternateLink: 'https://classroom.google.com/c/course-1',
        updateTime: '2026-08-17T11:00:00.000Z',
      };
      return new Response(JSON.stringify(url.pathname === '/v1/courses' ? { courses: [course] } : course));
    });
    const common = {
      connectionId: 27302, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing: ring, fetcher, nowEpochMs: NOW,
    };
    const before = await listGoogleClassroomCourseOptions(env.DB as AppDb, common);
    expect(before.programs).toEqual([{
      programId: 27303, slug: 'sunday-school', displayName: 'Sunday School', status: 'active',
    }]);
    expect(before.courses).toEqual([{
      course: expect.objectContaining({ externalCourseId: 'course-1', displayName: 'Genesis 1' }),
      mappedProgramId: null,
    }]);
    await expect(mapSelectedGoogleClassroomCourse(env.DB as AppDb, {
      ...common, externalCourseId: 'course-1', programId: 27303, actorPersonId: 27301,
      expectedRevision: 1, pushTopicName: null,
    })).resolves.toMatchObject({
      programId: 27303, connectionId: 27302, externalCourseId: 'course-1', displayName: 'Genesis 1',
    });
    const after = await listGoogleClassroomCourseOptions(env.DB as AppDb, common);
    expect(after.courses[0]?.mappedProgramId).toBe(27303);
    const stored = await env.DB.prepare(`SELECT display_name,launch_url FROM learning_courses
      WHERE connection_id=27302 AND external_course_id='course-1'`).first<Record<string, unknown>>();
    expect(stored).toEqual({ display_name: 'Genesis 1', launch_url: 'https://classroom.google.com/c/course-1' });
    expect(JSON.stringify(stored)).not.toMatch(/private-access|private-refresh|private-client-secret/iu);
  });

  it('checks health through the official Classroom endpoint with an encrypted credential only', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://classroom.googleapis.com');
      expect(url.pathname).toBe('/v1/courses');
      expect(url.searchParams.get('pageSize')).toBe('1');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-access');
      return new Response(null, { status: 200 });
    });
    await expect(checkGoogleClassroomConnectionHealth(env.DB as AppDb, {
      connectionId: 27302, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing: ring, fetcher, nowEpochMs: NOW,
    })).resolves.toEqual({ ok: true, errorCode: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('checks health for a recoverable error connection without widening ordinary provider access', async () => {
    await env.DB.prepare("UPDATE learning_provider_connections SET status='error' WHERE id=27302").run();
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://classroom.googleapis.com');
      expect(url.pathname).toBe('/v1/courses');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-access');
      return new Response(null, { status: 200 });
    });
    await expect(checkGoogleClassroomConnectionHealth(env.DB as AppDb, {
      connectionId: 27302, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing: ring, fetcher, nowEpochMs: NOW,
    })).resolves.toEqual({ ok: true, errorCode: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('disconnects an error connection whose remote OAuth grant was already revoked', async () => {
    await env.DB.prepare("UPDATE learning_provider_connections SET status='error' WHERE id=27302").run();
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const expiredEnvelope = await encryptLearningCredential(ring, {
      provider: 'google_classroom', connectionId: 27302,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'private-expired-access', refreshToken: 'private-revoked-refresh',
        accessTokenExpiresAt: '2026-08-17T11:00:00.000Z', refreshTokenExpiresAt: null,
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: null,
    });
    await env.DB.prepare(`UPDATE learning_provider_credentials SET
      ciphertext=?1,nonce=?2,algorithm=?3,key_version=?4,envelope_version=?5
      WHERE connection_id=27302`).bind(
      expiredEnvelope.ciphertext, expiredEnvelope.nonce, expiredEnvelope.algorithm,
      expiredEnvelope.keyVersion, expiredEnvelope.envelopeVersion,
    ).run();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.toString() === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400, headers: { 'content-type': 'application/json' },
        });
      }
      expect(url.toString()).toBe('https://oauth2.googleapis.com/revoke');
      return new Response(JSON.stringify({
        error: 'invalid_token', error_description: 'Token expired or revoked.',
      }), { status: 400, headers: { 'content-type': 'application/json' } });
    });
    await expect(disconnectGoogleClassroomConnection(env.DB as AppDb, {
      connectionId: 27302, expectedRevision: 1, actorPersonId: 27301,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
    })).resolves.toMatchObject({ status: 'disabled', revision: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_provider_credentials
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
  });

  it('revokes the refresh token before a CAS disconnect and rejects a stale revision before network access', async () => {
    await env.DB.prepare(`INSERT INTO learning_courses
      (program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(27303,27302,'google_classroom','course-disconnect','Disconnect course',
        'https://classroom.google.com/c/course-disconnect')`).run();
    await env.DB.prepare(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time) VALUES
      (27302,'course-disconnect','COURSE_ROSTER_CHANGES','disconnect-roster',
        'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z'),
      (27302,'course-disconnect','COURSE_WORK_CHANGES','disconnect-work',
        'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z')`).run();
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === 'https://classroom.googleapis.com') {
        expect(init?.method).toBe('DELETE');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-access');
        expect(['/v1/registrations/disconnect-roster', '/v1/registrations/disconnect-work']).toContain(url.pathname);
        return new Response(null, { status: 200 });
      }
      expect(url.toString()).toBe('https://oauth2.googleapis.com/revoke');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toBe('token=private-refresh');
      return new Response(null, { status: 200 });
    });
    const input = {
      connectionId: 27302, expectedRevision: 1, actorPersonId: 27301,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
    };
    await expect(disconnectGoogleClassroomConnection(env.DB as AppDb, {
      ...input, expectedRevision: 0,
    })).rejects.toBeInstanceOf(LearningConnectionConflictError);
    expect(fetcher).not.toHaveBeenCalled();

    await expect(disconnectGoogleClassroomConnection(env.DB as AppDb, input)).resolves.toMatchObject({
      connectionId: 27302, provider: 'google_classroom', status: 'disabled', revision: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await getLearningConnection(env.DB as AppDb, 27302, { includeDeleted: true })).toMatchObject({
      status: 'disabled', deletedAt: expect.any(String),
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_provider_credentials
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_google_registrations
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
  });

  it('durably disables before remote cleanup and leaves failed work recoverable', async () => {
    await env.DB.prepare(`INSERT INTO learning_courses
      (program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(27303,27302,'google_classroom','course-failure','Failure course',
        'https://classroom.google.com/c/course-failure')`).run();
    await env.DB.prepare(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
      VALUES(27302,'course-failure','COURSE_WORK_CHANGES','cleanup-fails',
        'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z')`).run();
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(disconnectGoogleClassroomConnection(env.DB as AppDb, {
      connectionId: 27302, expectedRevision: 1, actorPersonId: 27301,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
    })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await getLearningConnection(env.DB as AppDb, 27302, { includeDeleted: true })).toMatchObject({
      status: 'disabled', revision: 2, deletedAt: expect.any(String),
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_provider_credentials
      WHERE connection_id=27302`).first()).toEqual({ count: 1 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_google_registrations
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT task_type,registration_id FROM learning_google_cleanup_tasks
      WHERE connection_id=27302 ORDER BY task_type,registration_id`).all()).toMatchObject({ results: [
      { task_type: 'disconnect', registration_id: null },
      { task_type: 'registration', registration_id: 'cleanup-fails' },
    ] });

    const recoveryFetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.origin === 'https://classroom.googleapis.com') {
        expect(init?.method).toBe('DELETE');
        return new Response(null, { status: 404 });
      }
      expect(url.toString()).toBe('https://oauth2.googleapis.com/revoke');
      return new Response(null, { status: 200 });
    });
    const recoveryInput = {
      connectionId: 27302, clientId: 'client.apps.googleusercontent.com',
      clientSecret: 'private-client-secret', keyRing: ring, fetcher: recoveryFetcher,
      signal: new AbortController().signal, nowEpochMs: NOW + 61_000, limit: 8,
    };
    const recoveries = await Promise.all([
      recoverGoogleClassroomCleanup(env.DB as AppDb, recoveryInput),
      recoverGoogleClassroomCleanup(env.DB as AppDb, recoveryInput),
    ]);
    expect(recoveries.filter((result) => result.finalizedDisconnect)).toHaveLength(1);
    expect(recoveryFetcher).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_google_cleanup_tasks
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_provider_credentials
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
  });

  it('keeps one live disconnect claimant while an admin drain crosses sixty seconds and cron races', async () => {
    for (let course = 1; course <= 4; course += 1) {
      await env.DB.prepare(`INSERT INTO learning_courses
        (program_id,connection_id,provider,external_course_id,display_name,launch_url)
        VALUES(27303,27302,'google_classroom',?1,?2,?3)`)
        .bind(`lease-course-${course}`, `Lease course ${course}`, `https://classroom.google.com/c/lease-${course}`).run();
      await env.DB.prepare(`INSERT INTO learning_google_registrations
        (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time) VALUES
        (27302,?1,'COURSE_ROSTER_CHANGES',?2,'projects/church-project/topics/classroom',
          '2026-08-24T12:00:00.000Z'),
        (27302,?1,'COURSE_WORK_CHANGES',?3,'projects/church-project/topics/classroom',
          '2026-08-24T12:00:00.000Z')`)
        .bind(`lease-course-${course}`, `lease-${course}-roster`, `lease-${course}-work`).run();
    }
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    let current = NOW;
    let cronResult: Awaited<ReturnType<typeof recoverGoogleClassroomCleanup>> | null = null;
    const deleted: string[] = [];
    let revocations = 0;
    const now = () => current;
    const fetcher = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      if (url.origin === 'https://classroom.googleapis.com') {
        const registrationId = decodeURIComponent(url.pathname.slice('/v1/registrations/'.length));
        deleted.push(registrationId);
        current += 10_001;
        if (deleted.length === 7) {
          cronResult = await recoverGoogleClassroomCleanup(env.DB as AppDb, {
            connectionId: 27302, clientId: 'client.apps.googleusercontent.com',
            clientSecret: 'private-client-secret', keyRing: ring, fetcher,
            signal: new AbortController().signal, nowEpochMs: current, limit: 1,
          }, { now });
        }
        return new Response(null, { status: 200 });
      }
      expect(url.toString()).toBe('https://oauth2.googleapis.com/revoke');
      revocations += 1;
      return new Response(null, { status: 200 });
    });

    await expect(disconnectGoogleClassroomConnection(env.DB as AppDb, {
      connectionId: 27302, expectedRevision: 1, actorPersonId: 27301,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, nowEpochMs: NOW,
    }, { now })).resolves.toMatchObject({ status: 'disabled', revision: 2 });
    expect(current - NOW).toBeGreaterThan(60_000);
    expect(cronResult).toEqual({
      selected: 0, cleaned: 0, pending: 0, finalizedDisconnect: false,
    });
    expect(deleted).toHaveLength(8);
    expect(new Set(deleted).size).toBe(8);
    expect(revocations).toBe(1);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_google_cleanup_tasks
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
  });
});
