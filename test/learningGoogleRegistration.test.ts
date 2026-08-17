import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  createGoogleClassroomRegistration,
  deleteGoogleClassroomRegistration,
  listGoogleClassroomRegistrationsDue,
  saveGoogleClassroomRegistration,
} from '../src/lib/learningGooglePubSub';

const NOW = Date.parse('2026-08-17T12:00:00.000Z');

describe('Google Classroom registration API and renewal persistence', () => {
  it('creates one bounded official registration for the exact feed/course/topic', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://classroom.googleapis.com');
      expect(url.pathname).toBe('/v1/registrations');
      expect(url.searchParams.get('fields')).toBe('registrationId,expiryTime');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-access');
      expect(JSON.parse(String(init?.body))).toEqual({
        feed: { feedType: 'COURSE_WORK_CHANGES', courseWorkChangesInfo: { courseId: 'course-1' } },
        cloudPubsubTopic: { topicName: 'projects/church-project/topics/classroom' },
      });
      return new Response(JSON.stringify({
        registrationId: 'registration-new', expiryTime: '2026-08-24T12:00:00.000Z',
      }), { headers: { 'content-type': 'application/json', 'content-length': '77' } });
    });
    await expect(createGoogleClassroomRegistration({
      accessToken: 'private-access', externalCourseId: 'course-1', feedType: 'COURSE_WORK_CHANGES',
      topicName: 'projects/church-project/topics/classroom', fetcher,
      signal: new AbortController().signal, nowEpochMs: NOW,
    })).resolves.toEqual({
      externalCourseId: 'course-1', feedType: 'COURSE_WORK_CHANGES',
      registrationId: 'registration-new', topicName: 'projects/church-project/topics/classroom',
      expiryTime: '2026-08-24T12:00:00.000Z',
    });
  });

  it('deletes only the exact official registration and safely classifies an already absent registration', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).toBe('https://classroom.googleapis.com/v1/registrations/registration-old');
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 404 });
    });
    await expect(deleteGoogleClassroomRegistration({
      accessToken: 'private-access', registrationId: 'registration-old', fetcher,
      signal: new AbortController().signal,
    })).resolves.toBe(false);
  });

  it('bounds a registration fetcher that ignores abort and a response stream that never finishes', async () => {
    vi.useFakeTimers();
    try {
      const base = {
        accessToken: 'private-access', externalCourseId: 'course-1', feedType: 'COURSE_WORK_CHANGES' as const,
        topicName: 'projects/church-project/topics/classroom', signal: new AbortController().signal,
        nowEpochMs: NOW,
      };
      const pendingFetch = createGoogleClassroomRegistration({
        ...base,
        fetcher: async () => new Promise<Response>(() => undefined),
      });
      const pendingFetchAssertion = expect(pendingFetch).rejects.toThrow('learning_google_pubsub_invalid');
      await vi.advanceTimersByTimeAsync(10_001);
      await pendingFetchAssertion;

      const pendingStream = createGoogleClassroomRegistration({
        ...base,
        fetcher: async () => new Response(new ReadableStream<Uint8Array>({
          pull: async () => new Promise<void>(() => undefined),
        })),
      });
      const pendingStreamAssertion = expect(pendingStream).rejects.toThrow('learning_google_pubsub_invalid');
      await vi.advanceTimersByTimeAsync(10_001);
      await pendingStreamAssertion;
    } finally {
      vi.useRealTimers();
    }
  });

  describe('D1 parity', () => {
    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM learning_courses WHERE id=27204').run();
      await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=27202').run();
      await env.DB.prepare('DELETE FROM learning_programs WHERE id=27203').run();
      await env.DB.prepare('DELETE FROM people WHERE id=27201').run();
      await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27201,'Renew Admin','renew@example.test')").run();
      await env.DB.prepare(`INSERT INTO learning_provider_connections
        (id,provider,display_name,base_url,status,revision,created_by_person_id)
        VALUES(27202,'google_classroom','Classroom',NULL,'active',1,27201)`).run();
      await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(27203,'renew-test','Renew Test')").run();
      await env.DB.prepare(`INSERT INTO learning_courses
        (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
        VALUES(27204,27203,27202,'google_classroom','course-1','Course 1','https://classroom.google.com/c/course-1')`).run();
    });

    it('lists a bounded renewal horizon and CAS-replaces the expected registration', async () => {
      await env.DB.prepare(`INSERT INTO learning_google_registrations
        (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
        VALUES(27202,'course-1','COURSE_WORK_CHANGES','registration-old',
          'projects/church-project/topics/classroom','2026-08-18T12:00:00.000Z')`).run();
      expect(await listGoogleClassroomRegistrationsDue(env.DB as AppDb, {
        now: '2026-08-17T12:00:00.000Z', renewalHorizon: '2026-08-19T12:00:00.000Z',
        topicName: 'projects/church-project/topics/classroom', limit: 10,
      })).toEqual([{
        connectionId: 27202, externalCourseId: 'course-1', feedType: 'COURSE_WORK_CHANGES',
        registrationId: 'registration-old', topicName: 'projects/church-project/topics/classroom',
        expiryTime: '2026-08-18T12:00:00.000Z',
      }]);
      await expect(saveGoogleClassroomRegistration(env.DB as AppDb, {
        connectionId: 27202, expectedRegistrationId: 'registration-old',
        registration: {
          externalCourseId: 'course-1', feedType: 'COURSE_WORK_CHANGES', registrationId: 'registration-new',
          topicName: 'projects/church-project/topics/classroom', expiryTime: '2026-08-24T12:00:00.000Z',
        }, now: '2026-08-17T12:01:00.000Z',
      })).resolves.toEqual({ connectionId: 27202, registrationId: 'registration-new' });
      await expect(saveGoogleClassroomRegistration(env.DB as AppDb, {
        connectionId: 27202, expectedRegistrationId: 'registration-old',
        registration: {
          externalCourseId: 'course-1', feedType: 'COURSE_WORK_CHANGES', registrationId: 'stale-writer',
          topicName: 'projects/church-project/topics/classroom', expiryTime: '2026-08-24T12:00:00.000Z',
        }, now: '2026-08-17T12:02:00.000Z',
      })).rejects.toThrow('learning_google_pubsub_conflict');
    });
  });
});
