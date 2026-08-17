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

  it('revokes the refresh token before a CAS disconnect and rejects a stale revision before network access', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://oauth2.googleapis.com/revoke');
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toBe('token=private-refresh');
      return new Response(null, { status: 200 });
    });
    const input = {
      connectionId: 27302, expectedRevision: 1, actorPersonId: 27301,
      keyRing: ring, fetcher,
    };
    await expect(disconnectGoogleClassroomConnection(env.DB as AppDb, {
      ...input, expectedRevision: 0,
    })).rejects.toBeInstanceOf(LearningConnectionConflictError);
    expect(fetcher).not.toHaveBeenCalled();

    await expect(disconnectGoogleClassroomConnection(env.DB as AppDb, input)).resolves.toMatchObject({
      connectionId: 27302, provider: 'google_classroom', status: 'disabled', revision: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await getLearningConnection(env.DB as AppDb, 27302, { includeDeleted: true })).toMatchObject({
      status: 'disabled', deletedAt: expect.any(String),
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM learning_provider_credentials
      WHERE connection_id=27302`).first()).toEqual({ count: 0 });
  });
});
