import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, hasPg, pgClient, resetSchema } from './helpers';

const LEARNING_TABLES = [
  'learning_activities',
  'learning_activity_events',
  'learning_courses',
  'learning_enrollments',
  'learning_google_cleanup_tasks',
  'learning_google_notification_receipts',
  'learning_google_oauth_states',
  'learning_google_registrations',
  'learning_identity_links',
  'learning_programs',
  'learning_provider_connections',
  'learning_provider_credentials',
  'learning_resources',
  'learning_submission_snapshots',
  'learning_sync_runs',
];

type ActivityKind = 'material' | 'assignment' | 'quiz';
type SeededGraph = {
  connectionId: number;
  courseId: number;
  identityId: number;
  enrollmentId: number;
  activityId: number;
  personId: number;
};

describe.skipIf(!hasPg)('portable Learning schema (real Postgres)', () => {
  const sql = hasPg ? pgClient() : (null as never);
  const createdClientRoles: string[] = [];

  async function rejects(statement: string, code?: string | readonly string[]): Promise<void> {
    const error = await sql.unsafe(statement).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: expect.any(String) });
    if (code) {
      const expected = typeof code === 'string' ? [code] : code;
      expect(expected).toContain((error as { code: string }).code);
    }
  }

  async function seedGraph(
    seed: number,
    kind: ActivityKind = 'assignment',
    provider: 'google_classroom' | 'canvas' = 'canvas',
  ): Promise<SeededGraph> {
    const connectionId = seed * 10 + 1;
    const programId = seed * 10 + 2;
    const courseId = seed * 10 + 3;
    const identityId = seed * 10 + 4;
    const enrollmentId = seed * 10 + 5;
    const activityId = seed * 10 + 6;
    const personId = seed * 10 + 7;
    const baseUrl = provider === 'canvas' ? `'https://canvas-${seed}.example.test'` : 'NULL';
    await sql.unsafe(`
      INSERT INTO people (id,display_name,email)
        VALUES (${personId},'Learning Person ${seed}','learning-${seed}@example.test');
      INSERT INTO learning_provider_connections (id,provider,display_name,base_url,status)
        VALUES (${connectionId},'${provider}','Provider ${seed}',${baseUrl},'active');
      INSERT INTO learning_programs (id,slug,display_name)
        VALUES (${programId},'program-${seed}','Program ${seed}');
      INSERT INTO learning_courses
        (id,program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state)
        VALUES (${courseId},${programId},${connectionId},'${provider}','course-${seed}',
          'Course ${seed}','https://courses-${seed}.example.test/course','active');
      INSERT INTO learning_identity_links
        (id,connection_id,person_id,external_user_id,status)
        VALUES (${identityId},${connectionId},${personId},'user-${seed}','active');
      INSERT INTO learning_enrollments
        (id,connection_id,course_id,identity_link_id,external_enrollment_id,role,state)
        VALUES (${enrollmentId},${connectionId},${courseId},${identityId},'enrollment-${seed}',
          'student','active');
      INSERT INTO learning_activities
        (id,course_id,external_activity_id,title,kind,lifecycle_state,launch_url)
        VALUES (${activityId},${courseId},'activity-${seed}','Activity ${seed}','${kind}',
          'published','https://courses-${seed}.example.test/activity');
    `);
    return { connectionId, courseId, identityId, enrollmentId, activityId, personId };
  }

  beforeAll(async () => {
    const existingRoles = await sql.unsafe<{ rolname: string }[]>(`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated')
    `);
    for (const role of ['anon', 'authenticated']) {
      if (!existingRoles.some((row) => row.rolname === role)) {
        await sql.unsafe(`CREATE ROLE ${role} NOLOGIN`);
        createdClientRoles.push(role);
      }
    }
    await resetSchema(sql);
    await sql.unsafe('GRANT USAGE ON SCHEMA public TO anon, authenticated');
    execFileSync('node', ['scripts/db/migrate-supabase.mjs'], {
      env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL },
      encoding: 'utf8',
    });
  });

  afterAll(async () => {
    await sql?.unsafe('REVOKE USAGE ON SCHEMA public FROM anon, authenticated');
    for (const role of createdClientRoles.reverse()) await sql?.unsafe(`DROP ROLE ${role}`);
    await sql?.end();
  });

  it('keeps all fourteen tables server-only while preserving owner CRUD', async () => {
    const rls = await sql.unsafe<{ relname: string; relrowsecurity: boolean }[]>(`
      SELECT c.relname,c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname LIKE 'learning_%' AND c.relkind='r'
      ORDER BY c.relname
    `);
    expect(rls).toEqual(LEARNING_TABLES.map((relname) => ({ relname, relrowsecurity: true })));

    const grants = await sql.unsafe<{ table_name: string; grantee: string; privilege_type: string }[]>(`
      SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges
      WHERE table_schema='public' AND table_name LIKE 'learning_%'
        AND grantee IN ('PUBLIC','anon','authenticated')
      ORDER BY table_name,grantee,privilege_type
    `);
    expect(grants).toEqual([]);

    for (const role of ['anon', 'authenticated']) {
      try {
        await sql.unsafe(`SET ROLE ${role}`);
        await rejects('SELECT * FROM learning_programs', '42501');
        await rejects('SELECT * FROM learning_google_oauth_states', '42501');
        await rejects("INSERT INTO learning_programs (slug,display_name) VALUES ('browser','Browser')", '42501');
        await rejects(`INSERT INTO learning_google_notification_receipts
          (subscription_name,message_id,registration_id,external_course_id,collection_name,received_at)
          VALUES ('projects/p/subscriptions/s','m','r','c','courses.students','2026-08-17T12:00:00Z')`, '42501');
      } finally {
        await sql.unsafe('RESET ROLE');
      }
    }

    await sql.unsafe("INSERT INTO learning_programs (id,slug,display_name) VALUES (990001,'owner-crud','Owner CRUD')");
    await sql.unsafe("UPDATE learning_programs SET display_name='Owner updated' WHERE id=990001");
    expect((await sql.unsafe<{ display_name: string }[]>(
      'SELECT display_name FROM learning_programs WHERE id=990001',
    ))[0]?.display_name).toBe('Owner updated');
    await sql.unsafe('DELETE FROM learning_programs WHERE id=990001');
  });

  it('keeps Google OAuth envelopes binary and registration/receipt metadata bounded', async () => {
    const graph = await seedGraph(698, 'assignment', 'google_classroom');
    const columnTypes = await sql.unsafe<{ table_name: string; column_name: string; data_type: string }[]>(`
      SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND (
        (table_name='learning_google_oauth_states' AND column_name IN
          ('state_hash','session_hash','verifier_ciphertext','verifier_nonce')) OR
        (table_name='learning_google_registrations' AND column_name='expiry_time') OR
        (table_name='learning_google_notification_receipts' AND column_name='message_id')
      ) ORDER BY table_name,column_name
    `);
    expect(columnTypes).toEqual([
      { table_name: 'learning_google_notification_receipts', column_name: 'message_id', data_type: 'text' },
      { table_name: 'learning_google_oauth_states', column_name: 'session_hash', data_type: 'bytea' },
      { table_name: 'learning_google_oauth_states', column_name: 'state_hash', data_type: 'bytea' },
      { table_name: 'learning_google_oauth_states', column_name: 'verifier_ciphertext', data_type: 'bytea' },
      { table_name: 'learning_google_oauth_states', column_name: 'verifier_nonce', data_type: 'bytea' },
      { table_name: 'learning_google_registrations', column_name: 'expiry_time', data_type: 'text' },
    ]);
    await rejects(`INSERT INTO learning_google_oauth_states
      (connection_id,state_hash,session_hash,actor_person_id,connection_revision,redirect_uri,
       verifier_ciphertext,verifier_nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES (${graph.connectionId},decode(repeat('00',31),'hex'),decode(repeat('00',32),'hex'),
        ${graph.personId},1,'https://church.example.test/admin/learning/google/callback',
        decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),'AES-256-GCM',1,2,
        '2026-08-17T12:10:00.000Z')`, '23514');
    await sql.unsafe(`INSERT INTO learning_google_oauth_states
      (connection_id,state_hash,session_hash,actor_person_id,connection_revision,redirect_uri,
       verifier_ciphertext,verifier_nonce,algorithm,key_version,envelope_version,expires_at)
      VALUES (${graph.connectionId},decode(repeat('00',32),'hex'),decode(repeat('11',32),'hex'),
        ${graph.personId},1,'https://church.example.test/admin/learning/google/callback',
        decode(repeat('22',32),'hex'),decode(repeat('33',12),'hex'),'AES-256-GCM',1,2,
        '2026-08-17T12:10:00.000Z')`);
    await sql.unsafe(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time)
      VALUES (${graph.connectionId},'course-698','COURSE_WORK_CHANGES','registration-698',
        'projects/church/topics/classroom','2026-08-24T12:00:00.000Z')`);
    await sql.unsafe(`INSERT INTO learning_google_notification_receipts
      (subscription_name,message_id,registration_id,external_course_id,collection_name,received_at)
      VALUES ('projects/church/subscriptions/classroom','message-698','registration-698',
        'course-698','courses.courseWork','2026-08-17T12:00:00.000Z')`);
    await rejects(`INSERT INTO learning_google_notification_receipts
      (subscription_name,message_id,registration_id,external_course_id,collection_name,received_at)
      VALUES ('projects/church/subscriptions/classroom','message-698','registration-698',
        'course-698','courses.courseWork','2026-08-17T12:00:01.000Z')`, '23505');
  });

  it('persists bounded Learning lease, policy proof, and one-winner finalization markers', async () => {
    const columns = await sql.unsafe<{ table_name: string; column_name: string; data_type: string }[]>(`
      SELECT table_name,column_name,data_type FROM information_schema.columns
      WHERE table_schema='public' AND (
        (table_name='learning_provider_connections' AND column_name='operation_expires_at') OR
        (table_name='learning_sync_runs' AND column_name IN
          ('lease_marker','lease_expires_at','finalization_marker','url_policy_fingerprint'))
      ) ORDER BY table_name,column_name
    `);
    expect(columns).toEqual([
      { table_name: 'learning_provider_connections', column_name: 'operation_expires_at', data_type: 'text' },
      { table_name: 'learning_sync_runs', column_name: 'finalization_marker', data_type: 'text' },
      { table_name: 'learning_sync_runs', column_name: 'lease_expires_at', data_type: 'text' },
      { table_name: 'learning_sync_runs', column_name: 'lease_marker', data_type: 'text' },
      { table_name: 'learning_sync_runs', column_name: 'url_policy_fingerprint', data_type: 'bytea' },
    ]);
    const indexes = await sql.unsafe<{ indexname: string }[]>(`
      SELECT indexname FROM pg_indexes WHERE schemaname='public'
        AND indexname IN ('idx_learning_sync_runs_lease','idx_learning_sync_runs_finalization')
      ORDER BY indexname
    `);
    expect(indexes).toEqual([
      { indexname: 'idx_learning_sync_runs_finalization' },
      { indexname: 'idx_learning_sync_runs_lease' },
    ]);
  });

  it('accepts only a 32-byte URL-policy fingerprint', async () => {
    const graph = await seedGraph(699);
    for (const bytes of [31, 33]) {
      await rejects(`INSERT INTO learning_sync_runs
        (connection_id,course_id,trigger_type,status,url_policy_fingerprint)
        VALUES (${graph.connectionId},${graph.courseId},'manual','running',
          decode(repeat('00',${bytes}),'hex'))`, '23514');
    }
    await sql.unsafe(`INSERT INTO learning_sync_runs
      (connection_id,course_id,trigger_type,status,url_policy_fingerprint)
      VALUES (${graph.connectionId},${graph.courseId},'manual','running',decode(repeat('00',32),'hex'))`);
    expect((await sql.unsafe<{ storage_type: string; byte_length: number }[]>(`
      SELECT pg_typeof(url_policy_fingerprint)::text AS storage_type,
        octet_length(url_policy_fingerprint)::int AS byte_length
      FROM learning_sync_runs WHERE connection_id=${graph.connectionId}
    `))[0]).toEqual({ storage_type: 'bytea', byte_length: 32 });
  });

  it('enforces provider/envelope/resource/count bounds and rotates one bytea envelope', async () => {
    const graph = await seedGraph(700, 'assignment', 'google_classroom');
    await rejects(`INSERT INTO learning_provider_connections
      (provider,display_name,status) VALUES ('moodle','Bad','active')`, '23514');
    await rejects(`UPDATE learning_provider_connections SET revision='0.5'
      WHERE id=${graph.connectionId}`, '22P02');

    await sql.unsafe(`INSERT INTO learning_provider_credentials
      (connection_id,ciphertext,nonce,algorithm,key_version)
      VALUES (${graph.connectionId},decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),
        'AES-256-GCM',1)`);
    await sql.unsafe(`UPDATE learning_provider_credentials
      SET ciphertext=decode(repeat('11',48),'hex'),nonce=decode(repeat('22',16),'hex'),key_version=2
      WHERE connection_id=${graph.connectionId}`);
    expect((await sql.unsafe<{ count: number; key_version: number; ciphertext_length: number }[]>(`
      SELECT COUNT(*)::int AS count,MAX(key_version)::int AS key_version,
        MAX(octet_length(ciphertext))::int AS ciphertext_length
      FROM learning_provider_credentials WHERE connection_id=${graph.connectionId}
    `))[0]).toEqual({ count: 1, key_version: 2, ciphertext_length: 48 });
    await rejects(`UPDATE learning_provider_credentials SET key_version='2.5'
      WHERE connection_id=${graph.connectionId}`, '22P02');
    await rejects(`UPDATE learning_provider_credentials SET envelope_version='1.5'
      WHERE connection_id=${graph.connectionId}`, '22P02');
    await sql.unsafe(`UPDATE learning_provider_credentials SET envelope_version=2
      WHERE connection_id=${graph.connectionId}`);
    expect((await sql.unsafe<{ envelope_version: number }[]>(`
      SELECT envelope_version FROM learning_provider_credentials WHERE connection_id=${graph.connectionId}
    `))[0]).toEqual({ envelope_version: 2 });
    await sql.unsafe(`UPDATE learning_provider_credentials SET envelope_version=1
      WHERE connection_id=${graph.connectionId}`);
    await rejects(`UPDATE learning_provider_credentials SET envelope_version=3
      WHERE connection_id=${graph.connectionId}`, '23514');
    await rejects(`UPDATE learning_provider_credentials SET ciphertext=decode(repeat('00',15),'hex')
      WHERE connection_id=${graph.connectionId}`, '23514');

    await sql.unsafe(`INSERT INTO learning_resources
      (id,activity_id,external_resource_id,title,kind,launch_url,mime_type,size_bytes)
      VALUES (7008,${graph.activityId},'file-700','File','provider_file',
        'https://example.test/file','application/pdf',100)`);
    await rejects("UPDATE learning_resources SET size_bytes='0.5' WHERE id=7008", '22P02');

    await sql.unsafe(`INSERT INTO learning_sync_runs
      (id,connection_id,course_id,trigger_type,status,finished_at,attempt_count,
       scanned_count,changed_count,removed_count,event_count)
      VALUES (7009,${graph.connectionId},${graph.courseId},'manual','succeeded',
        '2026-08-16 12:00:00',1,1,1,1,1)`);
    for (const column of ['attempt_count', 'scanned_count', 'changed_count', 'removed_count', 'event_count']) {
      await rejects(`UPDATE learning_sync_runs SET ${column}='1.5' WHERE id=7009`, '22P02');
    }
    for (const column of ['scanned_count', 'changed_count', 'removed_count', 'event_count']) {
      await rejects(`UPDATE learning_sync_runs SET ${column}=100001 WHERE id=7009`, '23514');
    }
  });

  it('enforces snapshot/event discriminators, enrollment attribution, and active retention guards', async () => {
    const assignment = await seedGraph(710);
    const quiz = await seedGraph(711, 'quiz');
    const material = await seedGraph(712, 'material');
    const directActivity = await seedGraph(713, 'material');
    await sql.unsafe(`INSERT INTO learning_submission_snapshots
      (course_id,activity_id,activity_kind,enrollment_id,status,late,attempt_number)
      VALUES (${assignment.courseId},${assignment.activityId},'assignment',
        ${assignment.enrollmentId},'submitted',1,2)`);
    await rejects(`INSERT INTO learning_submission_snapshots
      (course_id,activity_id,activity_kind,enrollment_id,status)
      VALUES (${material.courseId},${material.activityId},'material',${material.enrollmentId},'submitted')`, '23514');
    await rejects(`UPDATE learning_submission_snapshots SET late='0.5'
      WHERE activity_id=${assignment.activityId}`, '22P02');
    await rejects(`UPDATE learning_submission_snapshots SET attempt_number='1.5'
      WHERE activity_id=${assignment.activityId}`, '22P02');
    await rejects(`UPDATE learning_activities SET kind='material' WHERE id=${assignment.activityId}`, '23503');

    await sql.unsafe(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at)
      VALUES ('pg-event-assignment',${assignment.connectionId},'canvas','pg-source-assignment',
        'assignment_submitted',${assignment.personId},${assignment.identityId},
        ${assignment.enrollmentId},${assignment.courseId},${assignment.activityId},'assignment',
        '2026-08-16 11:00:00')`);
    await sql.unsafe(`
      INSERT INTO people (id,display_name,email)
        VALUES (7197,'Alternate Person 7197','alternate-7197@example.test'),
          (7198,'Alternate Person 7198','alternate-7198@example.test');
      INSERT INTO learning_identity_links
        (id,connection_id,person_id,external_user_id,status)
        VALUES (7199,${assignment.connectionId},7198,'alternate-7199','active');
    `);
    await rejects(`UPDATE learning_enrollments SET identity_link_id=7199
      WHERE id=${assignment.enrollmentId}`, '23503');
    await rejects(`UPDATE learning_identity_links SET person_id=7197
      WHERE id=${assignment.identityId}`, '23503');
    await rejects(`DELETE FROM learning_enrollments WHERE id=${assignment.enrollmentId}`, '23503');
    await rejects(`DELETE FROM learning_identity_links WHERE id=${assignment.identityId}`, '23503');
    await sql.unsafe(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at)
      VALUES ('pg-event-quiz',${quiz.connectionId},'canvas','pg-source-quiz','quiz_submitted',
        ${quiz.personId},${quiz.identityId},${quiz.enrollmentId},${quiz.courseId},${quiz.activityId},
        'quiz','2026-08-16 11:00:00')`);
    await sql.unsafe(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at)
      VALUES ('pg-event-material',${material.connectionId},'canvas','pg-source-material',
        'resource_opened',${material.personId},${material.identityId},${material.enrollmentId},
        ${material.courseId},${material.activityId},'material','2026-08-16 11:00:00')`);
    await rejects(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       course_id,occurred_at)
      VALUES ('pg-no-enrollment',${assignment.connectionId},'canvas','pg-no-enrollment',
        'enrolled',${assignment.personId},${assignment.identityId},${assignment.courseId},
        '2026-08-16 11:00:00')`, '23502');
    await rejects(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at)
      VALUES ('pg-missing-enrollment',${assignment.connectionId},'canvas','pg-missing-enrollment',
        'assignment_submitted',${assignment.personId},${assignment.identityId},
        ${assignment.enrollmentId + 99},${assignment.courseId},${assignment.activityId},
        'assignment','2026-08-16 11:00:00')`, '23503');
    await rejects(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at)
      VALUES ('pg-cross-enrollment',${assignment.connectionId},'canvas','pg-cross-enrollment',
        'assignment_submitted',${assignment.personId},${assignment.identityId},${quiz.enrollmentId},
        ${assignment.courseId},${assignment.activityId},'assignment',
        '2026-08-16 11:00:00')`, '23503');
    await rejects(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at)
      VALUES ('pg-wrong-kind',${assignment.connectionId},'canvas','pg-wrong-kind','quiz_submitted',
        ${assignment.personId},${assignment.identityId},${assignment.enrollmentId},
        ${assignment.courseId},${assignment.activityId},'assignment','2026-08-16 11:00:00')`, '23514');
    await rejects("DELETE FROM learning_activity_events WHERE id='pg-event-assignment'", '23514');
    await rejects(`DELETE FROM learning_activities WHERE id=${directActivity.activityId}`, '23514');

    await sql.unsafe(`UPDATE learning_courses SET lifecycle_state='archived',
      deleted_at='2026-08-16 12:00:00' WHERE id=${assignment.courseId}`);
    await sql.unsafe("DELETE FROM learning_activity_events WHERE id='pg-event-assignment'");
    await sql.unsafe(`DELETE FROM learning_enrollments WHERE id=${assignment.enrollmentId}`);
    await sql.unsafe(`DELETE FROM learning_identity_links WHERE id=${assignment.identityId}`);
    await sql.unsafe(`UPDATE learning_provider_connections SET status='disabled',
      deleted_at='2026-08-16 12:00:00' WHERE id=${directActivity.connectionId}`);
    await sql.unsafe(`DELETE FROM learning_activities WHERE id=${directActivity.activityId}`);
  });

  it('cascades events through Person and course hard deletion', async () => {
    for (const [seed, parent] of [[720, 'person'], [721, 'course']] as const) {
      const graph = await seedGraph(seed);
      await sql.unsafe(`INSERT INTO learning_activity_events
        (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
         enrollment_id,course_id,activity_id,activity_kind,occurred_at)
        VALUES ('pg-event-${seed}',${graph.connectionId},'canvas','pg-source-${seed}',
          'assignment_submitted',${graph.personId},${graph.identityId},${graph.enrollmentId},
          ${graph.courseId},${graph.activityId},'assignment','2026-08-16 11:00:00')`);
      if (parent === 'person') await sql.unsafe(`DELETE FROM people WHERE id=${graph.personId}`);
      else await sql.unsafe(`DELETE FROM learning_courses WHERE id=${graph.courseId}`);
      expect(Number((await sql.unsafe<{ count: string }[]>(
        `SELECT COUNT(*) AS count FROM learning_activity_events WHERE id='pg-event-${seed}'`,
      ))[0]?.count)).toBe(0);
    }
  });
});
