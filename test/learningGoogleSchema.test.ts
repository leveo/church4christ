import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const TABLES = [
  'learning_google_oauth_states',
  'learning_google_registrations',
  'learning_google_notification_receipts',
  'learning_google_cleanup_tasks',
] as const;

async function columns(table: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results.map((row) => row.name).filter((name) => name !== 'campus_id');
}

describe('Google Classroom forward schema', () => {
  it('adds only bounded OAuth, registration, and dedupe metadata tables', async () => {
    expect(await columns(TABLES[0])).toEqual([
      'connection_id', 'state_hash', 'session_hash', 'actor_person_id', 'connection_revision',
      'redirect_uri', 'verifier_ciphertext', 'verifier_nonce', 'algorithm', 'key_version',
      'envelope_version', 'expires_at', 'claim_marker', 'created_at',
    ]);
    expect(await columns(TABLES[1])).toEqual([
      'connection_id', 'external_course_id', 'feed_type', 'registration_id',
      'topic_name', 'expiry_time', 'updated_at',
    ]);
    expect(await columns(TABLES[2])).toEqual([
      'subscription_name', 'message_id', 'registration_id', 'external_course_id',
      'collection_name', 'received_at', 'status', 'attempt_count', 'claim_marker',
      'claim_expires_at', 'completed_at',
    ]);
    expect(await columns(TABLES[3])).toEqual([
      'id', 'connection_id', 'task_type', 'registration_id', 'attempt_count',
      'claim_marker', 'claim_expires_at', 'last_attempt_at', 'created_at',
    ]);
    const forbidden = /payload|body|token|code_verifier|access_token|refresh_token|grade|answer|comment|file_bytes/iu;
    for (const table of TABLES) expect((await columns(table)).join(' ')).not.toMatch(forbidden);
  });

  it('enforces one active state per Google connection, exact binary envelopes, and expiry bounds', async () => {
    await env.DB.prepare("INSERT INTO people(id,display_name,email) VALUES(20701,'Google Admin','google-admin@example.test')").run();
    await env.DB.prepare(`INSERT INTO learning_provider_connections
      (id,provider,display_name,base_url,status,revision,created_by_person_id)
      VALUES(20702,'google_classroom','Classroom',NULL,'pending',3,20701)`).run();
    const insert = (connectionId: number, stateByte: number, nonceBytes = 12) => env.DB.prepare(`INSERT INTO learning_google_oauth_states
      (connection_id,state_hash,session_hash,actor_person_id,connection_revision,redirect_uri,
       verifier_ciphertext,verifier_nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES(?1,?2,?3,20701,4,'https://church.example.test/admin/learning/google/callback',
        ?4,?5,'AES-256-GCM',1,2,'2026-08-17T12:10:00.000Z')`)
      .bind(
        connectionId, new Uint8Array(32).fill(stateByte), new Uint8Array(32).fill(2),
        new Uint8Array(48).fill(3), new Uint8Array(nonceBytes).fill(4),
      ).run();
    await insert(20702, 1);
    await expect(insert(20702, 5)).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE learning_google_oauth_states SET state_hash=?1 WHERE connection_id=20702')
      .bind(new Uint8Array(31)).run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE learning_google_oauth_states SET verifier_nonce=?1 WHERE connection_id=20702')
      .bind(new Uint8Array(11)).run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE learning_google_oauth_states SET redirect_uri='https://church.example.test/admin/learning/google/callback?alias=1' WHERE connection_id=20702").run()).rejects.toThrow();
  });

  it('keeps one registration per course/feed and deduplicates at-least-once Pub/Sub delivery', async () => {
    await env.DB.prepare("INSERT INTO learning_programs(id,slug,display_name) VALUES(20703,'google-schema','Google Schema')").run();
    await env.DB.prepare(`UPDATE learning_provider_connections SET status='active' WHERE id=20702`).run();
    await env.DB.prepare(`INSERT INTO learning_courses
      (id,program_id,connection_id,provider,external_course_id,display_name,launch_url)
      VALUES(20704,20703,20702,'google_classroom','course-1','Course 1','https://classroom.google.com/c/course-1')`).run();
    await env.DB.prepare(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
      VALUES(20702,'course-1','COURSE_WORK_CHANGES','registration-1',
        'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z')`).run();
    await expect(env.DB.prepare(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
      VALUES(20702,'course-1','COURSE_WORK_CHANGES','registration-2',
        'projects/church-project/topics/classroom','2026-08-24T12:00:00.000Z')`).run()).rejects.toThrow();
    await env.DB.prepare(`INSERT INTO learning_google_notification_receipts
      (subscription_name,message_id,registration_id,external_course_id,collection_name,received_at)
      VALUES('projects/church-project/subscriptions/classroom','message-1','registration-1',
        'course-1','courses.courseWork','2026-08-17T12:00:00.000Z')`).run();
    await expect(env.DB.prepare(`INSERT INTO learning_google_notification_receipts
      (subscription_name,message_id,registration_id,external_course_id,collection_name,received_at)
      VALUES('projects/church-project/subscriptions/classroom','message-1','registration-1',
        'course-1','courses.courseWork','2026-08-17T12:00:01.000Z')`).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE learning_google_notification_receipts
      SET collection_name='courses.courseWork.grades' WHERE message_id='message-1'`).run()).rejects.toThrow();
  });
});
