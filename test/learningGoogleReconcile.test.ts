import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import { encodeGoogleCredential, GOOGLE_CLASSROOM_SCOPES } from '../src/lib/learningGoogleAuth';
import { reconcileGoogleClassroomCourse } from '../src/lib/learningGoogleReconcile';
import {
  encryptLearningCredential,
  importLearningCredentialKeyRing,
} from '../src/lib/learningCredentials';
import { learningSyntheticEnrollmentId } from '../src/lib/learningModel';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');
const KEY_SECRET = JSON.stringify({
  currentVersion: 1, keys: { 1: btoa(String.fromCharCode(...new Uint8Array(32).fill(29))) },
});
const ENROLLMENT_ID = learningSyntheticEnrollmentId({
  provider: 'google_classroom', externalCourseId: 'course-1', externalUserId: 'user-1',
});

describe('Google notification authoritative single-course reconciliation', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM learning_sync_runs WHERE connection_id=27402').run();
    await env.DB.prepare('DELETE FROM learning_courses WHERE connection_id=27402').run();
    await env.DB.prepare('DELETE FROM learning_identity_links WHERE connection_id=27402').run();
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=27402').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id=27403').run();
    await env.DB.prepare('DELETE FROM people WHERE id IN (27401,27405,27408)').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27401,'Sync Admin','sync-admin@example.test')").run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27405,'Linked Learner','linked@example.test')").run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27408,'Newly Linked Learner','newly-linked@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(27402,'google_classroom','Classroom',NULL,'active',1,27401)`).run();
    await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(27403,'push-sync','Push Sync')").run();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(27404,27403,27402,'google_classroom','course-1','Old title',
        'https://classroom.google.com/c/course-1')`).run();
    await env.DB.prepare(`INSERT INTO learning_identity_links
      (id,connection_id,person_id,external_user_id,status)
      VALUES(27406,27402,27405,'user-1','active')`).run();
    await env.DB.prepare(`INSERT INTO learning_identity_links
      (id,connection_id,person_id,external_user_id,status)
      VALUES(27409,27402,27408,'user-2','active')`).run();
    await env.DB.prepare(`INSERT INTO learning_enrollments
      (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state)
      VALUES(27407,27402,27404,27406,?1,'student','active')`).bind(ENROLLMENT_ID).run();
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const envelope = await encryptLearningCredential(ring, {
      provider: 'google_classroom', connectionId: 27402,
      plaintext: encodeGoogleCredential({
        version: 1, accessToken: 'private-access', refreshToken: 'private-refresh',
        accessTokenExpiresAt: '2026-08-17T13:00:00.000Z', refreshTokenExpiresAt: null,
        grantedScopes: GOOGLE_CLASSROOM_SCOPES,
      }), expiresAt: null,
    });
    await env.DB.prepare(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(27402,?1,?2,?3,?4,?5,NULL)`)
      .bind(envelope.ciphertext, envelope.nonce, envelope.algorithm, envelope.keyVersion, envelope.envelopeVersion).run();
  });

  it('loads only the mapped active graph and reconciles with strict preloaded identities', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://classroom.googleapis.com');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-access');
      if (url.pathname === '/v1/courses/course-1') return new Response(JSON.stringify({
        id: 'course-1', name: 'Genesis 1', courseState: 'ACTIVE',
        alternateLink: 'https://classroom.google.com/c/course-1',
        updateTime: '2026-08-17T11:55:00.000Z',
      }));
      if (url.pathname.endsWith('/teachers')) return new Response(JSON.stringify({ teachers: [
        { courseId: 'course-1', userId: 'user-1' },
        { courseId: 'course-1', userId: 'user-2' },
        { courseId: 'course-1', userId: 'new-unlinked-user' },
      ] }));
      if (url.pathname.endsWith('/students')) return new Response('{}');
      if (url.pathname.endsWith('/courseWorkMaterials')) return new Response('{}');
      if (url.pathname.endsWith('/courseWork')) return new Response('{}');
      throw new Error(`unexpected ${url.pathname}`);
    });
    await expect(reconcileGoogleClassroomCourse(env.DB as AppDb, {
      connectionId: 27402, externalCourseId: 'course-1', trigger: 'notification',
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, now: () => NOW, signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(await env.DB.prepare(`SELECT connection_id,course_id,status,trigger_type
      FROM learning_sync_runs WHERE connection_id=27402 ORDER BY id DESC LIMIT 1`).first()).toEqual({
      connection_id: 27402, course_id: 27404, status: 'succeeded', trigger_type: 'notification',
    });
    expect(await env.DB.prepare('SELECT display_name,last_synced_at FROM learning_courses WHERE id=27404').first())
      .toEqual({ display_name: 'Genesis 1', last_synced_at: '2026-08-17T12:00:00.000Z' });
    expect(await env.DB.prepare('SELECT role,state FROM learning_enrollments WHERE id=27407').first())
      .toEqual({ role: 'teacher', state: 'active' });
    expect(await env.DB.prepare(`SELECT identity_link_id,role,state FROM learning_enrollments
      WHERE course_id=27404 AND identity_link_id=27409`).first())
      .toEqual({ identity_link_id: 27409, role: 'teacher', state: 'active' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM learning_identity_links WHERE external_user_id='new-unlinked-user'").first())
      .toEqual({ count: 0 });
  });

  it('fails closed before credentials or network for an unmapped course or inactive connection', async () => {
    const ring = await importLearningCredentialKeyRing(KEY_SECRET);
    const fetcher = vi.fn(async () => { throw new Error('network must not run'); });
    const common = {
      connectionId: 27402, trigger: 'notification' as const,
      clientId: 'client.apps.googleusercontent.com', clientSecret: 'private-client-secret',
      keyRing: ring, fetcher, now: () => NOW, signal: new AbortController().signal,
    };
    await expect(reconcileGoogleClassroomCourse(env.DB as AppDb, {
      ...common, externalCourseId: 'unmapped-course',
    })).rejects.toThrow('learning_google_reconcile_failed');
    await env.DB.prepare("UPDATE learning_provider_connections SET status='disabled' WHERE id=27402").run();
    await expect(reconcileGoogleClassroomCourse(env.DB as AppDb, {
      ...common, externalCourseId: 'course-1',
    })).rejects.toThrow('learning_google_reconcile_failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
