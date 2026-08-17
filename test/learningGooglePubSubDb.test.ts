import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import {
  LearningGooglePubSubError,
  acceptGooglePubSubDelivery,
  finishGooglePubSubDelivery,
  type GooglePubSubDelivery,
} from '../src/lib/learningGooglePubSub';

const RECEIVED = '2026-08-17T12:00:00.000Z';

function delivery(
  messageId = 'message-1',
  registrationId = 'registration-work',
  receivedAt = RECEIVED,
): GooglePubSubDelivery {
  return Object.freeze({
    subscriptionName: 'projects/church-project/subscriptions/classroom',
    messageId, registrationId, collection: 'courses.courseWork', externalCourseId: 'course-1',
    resourceId: Object.freeze({ courseId: 'course-1', id: 'work-1' }),
    publishedAt: '2026-08-17T11:59:59.000Z', receivedAt,
  });
}

describe('Google Pub/Sub authoritative registration lookup and deduplication', () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM learning_google_notification_receipts WHERE subscription_name='projects/church-project/subscriptions/classroom'").run();
    await env.DB.prepare('DELETE FROM learning_courses WHERE id=27104').run();
    await env.DB.prepare('DELETE FROM learning_provider_connections WHERE id=27102').run();
    await env.DB.prepare('DELETE FROM learning_programs WHERE id=27103').run();
    await env.DB.prepare('DELETE FROM people WHERE id=27101').run();
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(27101,'Push Admin','push@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(27102,'google_classroom','Classroom',NULL,'active',1,27101)`).run();
    await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(27103,'push-test','Push Test')").run();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(27104,27103,27102,'google_classroom','course-1','Course 1','https://classroom.google.com/c/course-1')`).run();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO learning_google_registrations
        (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
        VALUES(27102,'course-1','COURSE_WORK_CHANGES','registration-work',
          'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z')`),
      env.DB.prepare(`INSERT INTO learning_google_registrations
        (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
        VALUES(27102,'course-1','COURSE_ROSTER_CHANGES','registration-roster',
          'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z')`),
    ]);
  });

  it('lets exactly one concurrent delivery claim work and treats a succeeded replay as terminal', async () => {
    const calls = await Promise.all([
      acceptGooglePubSubDelivery(env.DB as AppDb, delivery()),
      acceptGooglePubSubDelivery(env.DB as AppDb, delivery()),
    ]);
    expect(calls.filter((value) => value.disposition === 'claimed')).toHaveLength(1);
    expect(calls.filter((value) => value.disposition === 'in_progress')).toHaveLength(1);
    expect(calls[0]).toMatchObject({ connectionId: 27102, externalCourseId: 'course-1' });
    const claimed = calls.find((value) => value.disposition === 'claimed')!;
    await expect(finishGooglePubSubDelivery(env.DB as AppDb, {
      receipt: claimed, outcome: 'succeeded', completedAt: '2026-08-17T12:00:10.000Z',
    })).resolves.toBeUndefined();
    await expect(acceptGooglePubSubDelivery(env.DB as AppDb, delivery(
      'message-1', 'registration-work', '2026-08-17T12:00:11.000Z',
    ))).resolves.toMatchObject({ disposition: 'succeeded', claimMarker: null, attemptCount: 1 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM learning_google_notification_receipts').first('count')).toBe(1);
  });

  it('reclaims failed and stale-pending work with a new bounded CAS attempt', async () => {
    const failed = await acceptGooglePubSubDelivery(env.DB as AppDb, delivery('message-failed'));
    expect(failed).toMatchObject({ disposition: 'claimed', attemptCount: 1 });
    await finishGooglePubSubDelivery(env.DB as AppDb, {
      receipt: failed, outcome: 'failed', completedAt: '2026-08-17T12:00:01.000Z',
    });
    const retry = await acceptGooglePubSubDelivery(env.DB as AppDb, delivery(
      'message-failed', 'registration-work', '2026-08-17T12:00:02.000Z',
    ));
    expect(retry).toMatchObject({ disposition: 'claimed', attemptCount: 2 });
    expect(retry.claimMarker).not.toBe(failed.claimMarker);

    const stale = await acceptGooglePubSubDelivery(env.DB as AppDb, delivery('message-stale'));
    const recovered = await acceptGooglePubSubDelivery(env.DB as AppDb, delivery(
      'message-stale', 'registration-work', '2026-08-17T12:02:01.000Z',
    ));
    expect(recovered).toMatchObject({ disposition: 'claimed', attemptCount: 2 });
    expect(recovered.claimMarker).not.toBe(stale.claimMarker);
  });

  it('rejects unknown/mismatched registration, course, or feed instead of trusting notification routing data', async () => {
    await expect(acceptGooglePubSubDelivery(env.DB as AppDb, delivery('message-2', 'unknown-registration')))
      .rejects.toBeInstanceOf(LearningGooglePubSubError);
    await expect(acceptGooglePubSubDelivery(env.DB as AppDb, {
      ...delivery('message-3', 'registration-roster'), collection: 'courses.courseWork',
    })).rejects.toBeInstanceOf(LearningGooglePubSubError);
    await expect(acceptGooglePubSubDelivery(env.DB as AppDb, {
      ...delivery('message-4'), externalCourseId: 'course-other',
      resourceId: { courseId: 'course-other', id: 'work-1' },
    })).rejects.toBeInstanceOf(LearningGooglePubSubError);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM learning_google_notification_receipts').first('count')).toBe(0);
  });
});
