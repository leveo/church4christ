import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const LEARNING_TABLES = [
  'learning_activities',
  'learning_activity_events',
  'learning_canvas_cleanup_tasks',
  'learning_canvas_event_receipts',
  'learning_canvas_oauth_states',
  'learning_canvas_webhook_configs',
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
] as const;

const LEARNING_INDEXES = [
  'idx_learning_activities_course_due',
  'idx_learning_activities_course_kind',
  'idx_learning_canvas_cleanup_recovery',
  'idx_learning_canvas_oauth_expiry',
  'idx_learning_canvas_receipts_recovery',
  'idx_learning_canvas_receipts_retention',
  'idx_learning_canvas_webhook_account',
  'idx_learning_connections_active_sync',
  'idx_learning_connections_campus',
  'idx_learning_courses_connection_sync',
  'idx_learning_courses_program_state',
  'idx_learning_courses_sync_schedule',
  'idx_learning_enrollments_course_state',
  'idx_learning_enrollments_identity_state',
  'idx_learning_events_activity_score',
  'idx_learning_events_activity_time',
  'idx_learning_events_connection_ingested',
  'idx_learning_events_course_time',
  'idx_learning_events_enrollment_time',
  'idx_learning_events_person_time',
  'idx_learning_google_cleanup_claim',
  'idx_learning_google_cleanup_disconnect',
  'idx_learning_google_cleanup_drain',
  'idx_learning_google_cleanup_registration',
  'idx_learning_google_oauth_expiry',
  'idx_learning_google_receipts_claim_marker',
  'idx_learning_google_receipts_recovery',
  'idx_learning_google_receipts_retention',
  'idx_learning_google_registrations_renewal',
  'idx_learning_identities_person_status',
  'idx_learning_programs_active_name',
  'idx_learning_programs_campus',
  'idx_learning_resources_activity_kind',
  'idx_learning_snapshots_course_state',
  'idx_learning_snapshots_enrollment_state',
  'idx_learning_sync_runs_connection_time',
  'idx_learning_sync_runs_course_time',
  'idx_learning_sync_runs_finalization',
  'idx_learning_sync_runs_lease',
  'idx_learning_sync_runs_status_time',
] as const;

async function reject(statement: string): Promise<void> {
  await expect(env.DB.prepare(statement).run()).rejects.toThrow();
}

async function columns(table: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results.map((column) => column.name).filter((name) => name !== 'campus_id');
}

type SeededGraph = {
  connectionId: number;
  programId: number;
  courseId: number;
  identityId: number;
  enrollmentId: number;
  activityId: number;
  personId: number;
};

async function seedGraph(
  seed: number,
  provider: 'google_classroom' | 'canvas' = 'canvas',
  activityKind: 'material' | 'assignment' | 'quiz' = 'assignment',
): Promise<SeededGraph> {
  const connectionId = seed * 10 + 1;
  const programId = seed * 10 + 2;
  const courseId = seed * 10 + 3;
  const identityId = seed * 10 + 4;
  const enrollmentId = seed * 10 + 5;
  const activityId = seed * 10 + 6;
  const personId = seed * 10 + 7;
  const baseUrl = provider === 'canvas' ? `'https://canvas-${seed}.example.test'` : 'NULL';

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO people (id, display_name, email)
      VALUES (${personId}, 'Learning Person ${seed}', 'learning-${seed}@example.test')`),
    env.DB.prepare(`INSERT INTO learning_provider_connections
      (id, provider, display_name, base_url, status)
      VALUES (${connectionId}, '${provider}', 'Provider ${seed}', ${baseUrl}, 'active')`),
    env.DB.prepare(`INSERT INTO learning_programs
      (id, slug, display_name) VALUES (${programId}, 'program-${seed}', 'Program ${seed}')`),
    env.DB.prepare(`INSERT INTO learning_courses
      (id, program_id, connection_id, provider, external_course_id, display_name, launch_url,
       lifecycle_state)
      VALUES (${courseId}, ${programId}, ${connectionId}, '${provider}', 'course-${seed}',
        'Course ${seed}', 'https://courses-${seed}.example.test/course', 'active')`),
    env.DB.prepare(`INSERT INTO learning_identity_links
      (id, connection_id, person_id, external_user_id, status)
      VALUES (${identityId}, ${connectionId}, ${personId}, 'user-${seed}', 'active')`),
    env.DB.prepare(`INSERT INTO learning_enrollments
      (id, connection_id, course_id, identity_link_id, external_enrollment_id, role, state)
      VALUES (${enrollmentId}, ${connectionId}, ${courseId}, ${identityId}, 'enrollment-${seed}',
        'student', 'active')`),
    env.DB.prepare(`INSERT INTO learning_activities
      (id, course_id, external_activity_id, title, kind, lifecycle_state, launch_url)
      VALUES (${activityId}, ${courseId}, 'activity-${seed}', 'Activity ${seed}', '${activityKind}',
        'published', 'https://courses-${seed}.example.test/activity')`),
  ]);

  return { connectionId, programId, courseId, identityId, enrollmentId, activityId, personId };
}

async function insertSubjectEvent(graph: SeededGraph, id: string): Promise<void> {
  const eventColumns = await columns('learning_activity_events');
  const stableSubjectColumns = eventColumns.includes('identity_link_id')
    ? ', person_id, identity_link_id'
    : '';
  const stableSubjectValues = eventColumns.includes('identity_link_id')
    ? `, ${graph.personId}, ${graph.identityId}`
    : '';
  await env.DB.prepare(`INSERT INTO learning_activity_events
    (id, connection_id, provider, source_event_id, event_type, enrollment_id, course_id,
     activity_id, activity_kind${stableSubjectColumns}, occurred_at)
    VALUES ('${id}', ${graph.connectionId}, 'canvas', '${id}', 'assignment_submitted',
      ${graph.enrollmentId}, ${graph.courseId}, ${graph.activityId}, 'assignment'
      ${stableSubjectValues}, '2026-08-16 11:00:00')`).run();
}

async function addPerson(id: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO people (id, display_name, email)
    VALUES (${id}, 'Alternate Person ${id}', 'alternate-${id}@example.test')`).run();
}

async function addIdentity(graph: SeededGraph, identityId: number, personId: number): Promise<void> {
  await addPerson(personId);
  await env.DB.prepare(`INSERT INTO learning_identity_links
    (id, connection_id, person_id, external_user_id, status)
    VALUES (${identityId}, ${graph.connectionId}, ${personId}, 'alternate-${identityId}', 'active')`).run();
}

describe('portable Learning schema (D1)', () => {
  it('creates only the bounded normalized Learning relations and operational indexes', async () => {
    const tables = await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'learning_%' ORDER BY name
    `).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(LEARNING_TABLES);

    const indexes = await env.DB.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_learning_%' ORDER BY name
    `).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual(LEARNING_INDEXES);

    expect(await columns('learning_provider_credentials')).toEqual([
      'connection_id', 'ciphertext', 'nonce', 'algorithm', 'key_version', 'envelope_version',
      'expires_at', 'updated_at',
    ]);
    expect(await columns('learning_submission_snapshots')).toEqual([
      'course_id', 'activity_id', 'activity_kind', 'enrollment_id', 'status', 'late', 'attempt_number',
      'submitted_at', 'returned_at', 'provider_updated_at', 'synced_at',
    ]);
    expect(await columns('learning_activity_events')).toEqual([
      'id', 'connection_id', 'provider', 'source_event_id', 'event_type', 'person_id',
      'identity_link_id', 'enrollment_id', 'course_id', 'activity_id', 'activity_kind',
      'occurred_at', 'ingested_at',
    ]);
    expect(await columns('learning_canvas_event_receipts')).toEqual([
      'connection_id', 'source_event_id', 'external_course_id', 'event_name', 'received_at',
      'status', 'attempt_count', 'claim_marker', 'claim_expires_at', 'completed_at',
    ]);
    expect(await columns('learning_canvas_cleanup_tasks')).toEqual([
      'connection_id', 'ciphertext', 'nonce', 'algorithm', 'key_version', 'envelope_version',
      'expires_at', 'attempt_count', 'claim_marker', 'claim_expires_at', 'last_attempt_at', 'created_at',
    ]);
    expect(await columns('learning_canvas_webhook_configs')).toEqual([
      'connection_id', 'root_account_id', 'verification_mode', 'jwk_set_url', 'status', 'updated_at',
    ]);
    expect(await columns('learning_provider_connections')).toContain('operation_expires_at');
    expect(await columns('learning_courses')).toContain('last_sync_attempt_at');
    expect(await columns('learning_sync_runs')).toEqual(expect.arrayContaining([
      'lease_marker', 'lease_expires_at', 'finalization_marker', 'url_policy_fingerprint',
    ]));

    const forbidden = /(?:access|refresh)_token|oauth_code|client_secret|plaintext|payload|homework|answer|comment|grade|rubric|file_bytes|content/i;
    for (const table of [
      'learning_provider_credentials',
      'learning_submission_snapshots',
      'learning_activity_events',
      'learning_canvas_event_receipts',
      'learning_canvas_cleanup_tasks',
    ]) {
      expect((await columns(table)).filter((column) => forbidden.test(column))).toEqual([]);
    }
    expect(await columns('learning_canvas_event_receipts')).not.toContain('payload');
  });

  it('stores only a fixed-length binary URL-policy fingerprint on a sync run', async () => {
    const graph = await seedGraph(95);
    for (const value of ["'not-binary'", 'zeroblob(31)', 'zeroblob(33)']) {
      await reject(`INSERT INTO learning_sync_runs
        (id,connection_id,course_id,trigger_type,status,url_policy_fingerprint)
        VALUES (95${value.length},${graph.connectionId},${graph.courseId},'manual','running',${value})`);
    }
    await env.DB.prepare(`INSERT INTO learning_sync_runs
      (id,connection_id,course_id,trigger_type,status,url_policy_fingerprint)
      VALUES (9599,${graph.connectionId},${graph.courseId},'manual','running',zeroblob(32))`).run();
    expect(await env.DB.prepare(`SELECT typeof(url_policy_fingerprint) AS storage_type,
      length(url_policy_fingerprint) AS byte_length FROM learning_sync_runs WHERE id=9599`).first())
      .toEqual({ storage_type: 'blob', byte_length: 32 });
  });

  it('enforces provider allowlists, provider/course coherence, soft deletion, and scoped uniqueness', async () => {
    const graph = await seedGraph(100);
    await reject(`INSERT INTO learning_provider_connections
      (id, provider, display_name, status) VALUES (1091, 'moodle', 'Other', 'active')`);
    await reject(`INSERT INTO learning_provider_connections
      (id, provider, display_name, base_url, status)
      VALUES (1092, 'canvas', 'Missing URL', NULL, 'active')`);
    await reject(`INSERT INTO learning_provider_connections
      (id, provider, display_name, base_url, status)
      VALUES (1093, 'google_classroom', 'Unexpected URL', 'https://classroom.google.com', 'active')`);
    await reject(`INSERT INTO learning_provider_connections
      (id, provider, display_name, status) VALUES (1094, 'google_classroom', 'Bad state', 'ready')`);
    await reject(`INSERT INTO learning_programs
      (id, slug, display_name) VALUES (1095, 'Bad Slug', 'Bad slug')`);
    await reject(`UPDATE learning_provider_connections
      SET revision = 0.5 WHERE id = ${graph.connectionId}`);
    await reject(`UPDATE learning_provider_connections
      SET deleted_at = '2026-08-16 12:00:00' WHERE id = ${graph.connectionId}`);

    await reject(`INSERT INTO learning_courses
      (id, program_id, connection_id, provider, external_course_id, display_name, launch_url, lifecycle_state)
      VALUES (1096, ${graph.programId}, ${graph.connectionId}, 'google_classroom', 'wrong-provider',
        'Wrong provider', 'https://classroom.google.com/course', 'active')`);
    await reject(`INSERT INTO learning_courses
      (id, program_id, connection_id, provider, external_course_id, display_name, launch_url, lifecycle_state)
      VALUES (1097, ${graph.programId}, ${graph.connectionId}, 'canvas', 'course-100',
        'Duplicate external id', 'https://canvas-100.example.test/course-2', 'active')`);
    await reject(`INSERT INTO learning_courses
      (id, program_id, connection_id, provider, external_course_id, display_name, launch_url, lifecycle_state)
      VALUES (1098, ${graph.programId}, ${graph.connectionId}, 'canvas', 'insecure-url',
        'Insecure URL', 'http://canvas-100.example.test/course', 'active')`);

    await env.DB.prepare(`UPDATE learning_provider_connections
      SET status = 'disabled', deleted_at = '2026-08-16 12:00:00'
      WHERE id = ${graph.connectionId}`).run();
    expect(await env.DB.prepare(`SELECT status, deleted_at FROM learning_provider_connections
      WHERE id = ${graph.connectionId}`).first()).toEqual({
      status: 'disabled',
      deleted_at: '2026-08-16 12:00:00',
    });
  });

  it('stores one versioned encrypted credential envelope and rejects unsafe envelope metadata', async () => {
    const graph = await seedGraph(200, 'google_classroom');
    await env.DB.prepare(`INSERT INTO learning_provider_credentials
      (connection_id, ciphertext, nonce, algorithm, key_version)
      VALUES (${graph.connectionId}, zeroblob(32), zeroblob(12), 'AES-256-GCM', 1)`).run();
    expect(await env.DB.prepare(`SELECT algorithm, key_version, envelope_version,
      length(ciphertext) AS ciphertext_length, length(nonce) AS nonce_length,
      length(updated_at) AS updated_length
      FROM learning_provider_credentials WHERE connection_id = ${graph.connectionId}`).first()).toEqual({
      algorithm: 'AES-256-GCM',
      key_version: 1,
      envelope_version: 1,
      ciphertext_length: 32,
      nonce_length: 12,
      updated_length: 19,
    });

    await reject(`INSERT INTO learning_provider_credentials
      (connection_id, ciphertext, nonce, algorithm, key_version)
      VALUES (${graph.connectionId}, zeroblob(32), zeroblob(12), 'AES-256-GCM', 2)`);
    await reject(`INSERT INTO learning_provider_credentials
      (connection_id, ciphertext, nonce, algorithm, key_version)
      VALUES (2991, zeroblob(32), zeroblob(12), 'AES-256-GCM', 1)`);

    await env.DB.prepare(`UPDATE learning_provider_credentials
      SET ciphertext = zeroblob(48), nonce = zeroblob(16), key_version = 2
      WHERE connection_id = ${graph.connectionId}`).run();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count, key_version,
      length(ciphertext) AS ciphertext_length, length(nonce) AS nonce_length
      FROM learning_provider_credentials WHERE connection_id = ${graph.connectionId}`)
      .first()).toEqual({ count: 1, key_version: 2, ciphertext_length: 48, nonce_length: 16 });
    await reject(`UPDATE learning_provider_credentials SET key_version = 2.5
      WHERE connection_id = ${graph.connectionId}`);
    await reject(`UPDATE learning_provider_credentials SET envelope_version = 1.5
      WHERE connection_id = ${graph.connectionId}`);
    await env.DB.prepare(`UPDATE learning_provider_credentials SET envelope_version = 2
      WHERE connection_id = ${graph.connectionId}`).run();
    expect(await env.DB.prepare(`SELECT envelope_version FROM learning_provider_credentials
      WHERE connection_id = ${graph.connectionId}`).first()).toEqual({ envelope_version: 2 });
    await env.DB.prepare(`UPDATE learning_provider_credentials SET envelope_version = 1
      WHERE connection_id = ${graph.connectionId}`).run();
    await reject(`UPDATE learning_provider_credentials SET envelope_version = 3
      WHERE connection_id = ${graph.connectionId}`);

    const other = await seedGraph(201);
    for (const values of [
      `(${other.connectionId}, zeroblob(15), zeroblob(12), 'AES-256-GCM', 1, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(11), 'AES-256-GCM', 1, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(12), 'AES-CBC', 1, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(12), 'AES-256-GCM', 0, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(12), 'AES-256-GCM', 1, 3)`,
    ]) {
      await reject(`INSERT INTO learning_provider_credentials
        (connection_id, ciphertext, nonce, algorithm, key_version, envelope_version) VALUES ${values}`);
    }
  });

  it('rejects correctly sized TEXT ciphertext instead of relying on SQLite length alone', async () => {
    const graph = await seedGraph(210);
    await reject(`INSERT INTO learning_provider_credentials
      (connection_id, ciphertext, nonce, algorithm, key_version)
      VALUES (${graph.connectionId}, '0123456789abcdef', zeroblob(12), 'AES-256-GCM', 1)`);
  });

  it('rejects correctly sized TEXT nonces instead of relying on SQLite length alone', async () => {
    const graph = await seedGraph(211);
    await reject(`INSERT INTO learning_provider_credentials
      (connection_id, ciphertext, nonce, algorithm, key_version)
      VALUES (${graph.connectionId}, zeroblob(16), '0123456789ab', 'AES-256-GCM', 1)`);
  });

  it('normalizes identities, enrollments, activities, and resources with exact bounded enums', async () => {
    const graph = await seedGraph(300);
    await env.DB.prepare(`INSERT INTO learning_resources
      (id, activity_id, external_resource_id, title, kind, launch_url, youtube_video_id)
      VALUES (3008, ${graph.activityId}, 'resource-300', 'Prepared video', 'youtube',
        'https://www.youtube.com/watch?v=abcdefghijk', 'abcdefghijk')`).run();

    for (const statement of [
      `UPDATE learning_identity_links SET status = 'merged' WHERE id = ${graph.identityId}`,
      `UPDATE learning_enrollments SET role = 'owner' WHERE id = ${graph.enrollmentId}`,
      `UPDATE learning_enrollments SET state = 'withdrawn' WHERE id = ${graph.enrollmentId}`,
      `UPDATE learning_activities SET kind = 'discussion' WHERE id = ${graph.activityId}`,
      `UPDATE learning_activities SET lifecycle_state = 'open' WHERE id = ${graph.activityId}`,
      `INSERT INTO learning_resources
        (id, activity_id, external_resource_id, title, kind, launch_url)
        VALUES (3096, ${graph.activityId}, 'bad-resource', 'Bad resource', 'upload',
          'https://canvas-300.example.test/resource')`,
      `INSERT INTO learning_resources
        (id, activity_id, external_resource_id, title, kind, launch_url, youtube_video_id)
        VALUES (3097, ${graph.activityId}, 'bad-video', 'Bad video', 'youtube',
          'https://www.youtube.com/watch?v=short', 'short')`,
      `INSERT INTO learning_resources
        (id, activity_id, external_resource_id, title, kind, launch_url, size_bytes)
        VALUES (3098, ${graph.activityId}, 'bad-link-size', 'Bad link', 'link',
          'https://example.test/resource', 10)`,
      `INSERT INTO learning_resources
        (id, activity_id, external_resource_id, title, kind, launch_url, mime_type, size_bytes)
        VALUES (3095, ${graph.activityId}, 'fractional-file', 'Fractional file', 'provider_file',
          'https://example.test/file', 'application/pdf', 0.5)`,
      `INSERT INTO learning_activities
        (id, course_id, external_activity_id, title, kind, lifecycle_state, launch_url)
        VALUES (3099, ${graph.courseId}, '${'x'.repeat(256)}', 'Too long', 'material', 'published',
          'https://canvas-300.example.test/activity')`,
    ]) await reject(statement);

    const foreignKeys = await env.DB.prepare('PRAGMA foreign_key_list(learning_enrollments)')
      .all<{ table: string; from: string; to: string; on_delete: string }>();
    expect(foreignKeys.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'learning_courses', from: 'course_id', to: 'id', on_delete: 'CASCADE' }),
      expect.objectContaining({ table: 'learning_identity_links', from: 'identity_link_id', to: 'id', on_delete: 'CASCADE' }),
    ]));
  });

  it('keeps one privacy-bounded current submission snapshot per learner and activity', async () => {
    const graph = await seedGraph(400);
    const materialGraph = await seedGraph(401, 'canvas', 'material');
    await env.DB.prepare(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, activity_kind, enrollment_id, status, late, attempt_number, submitted_at,
       provider_updated_at)
      VALUES (${graph.courseId}, ${graph.activityId}, 'assignment', ${graph.enrollmentId}, 'submitted', 1, 2,
        '2026-08-16 10:00:00', '2026-08-16 10:01:00')`).run();
    expect(await env.DB.prepare(`SELECT status, late, attempt_number, length(synced_at) AS synced_length
      FROM learning_submission_snapshots WHERE activity_id = ${graph.activityId}`).first()).toEqual({
      status: 'submitted',
      late: 1,
      attempt_number: 2,
      synced_length: 19,
    });

    await reject(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, activity_kind, enrollment_id, status, late, attempt_number)
      VALUES (${graph.courseId}, ${graph.activityId}, 'assignment', ${graph.enrollmentId + 99},
        'submitted', 0, 1)`);
    await reject(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, activity_kind, enrollment_id, status)
      VALUES (${graph.courseId}, ${graph.activityId}, 'quiz', ${graph.enrollmentId}, 'submitted')`);
    await reject(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, activity_kind, enrollment_id, status)
      VALUES (${materialGraph.courseId}, ${materialGraph.activityId}, 'material',
        ${materialGraph.enrollmentId}, 'submitted')`);
    await reject(`UPDATE learning_submission_snapshots SET status = 'graded'
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
    await reject(`UPDATE learning_submission_snapshots SET late = 2
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
    await reject(`UPDATE learning_submission_snapshots SET late = 0.5
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
    await reject(`UPDATE learning_submission_snapshots SET attempt_number = 1001
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
    await reject(`UPDATE learning_submission_snapshots SET attempt_number = 2.5
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
    await reject(`UPDATE learning_activities SET kind = 'material' WHERE id = ${graph.activityId}`);
  });

  it('locks an event subject against enrollment identity reassignment', async () => {
    const graph = await seedGraph(490);
    const alternateIdentityId = 4908;
    await addIdentity(graph, alternateIdentityId, 4909);
    await insertSubjectEvent(graph, 'event-subject-enrollment-update');

    await reject(`UPDATE learning_enrollments SET identity_link_id = ${alternateIdentityId}
      WHERE id = ${graph.enrollmentId}`);
    expect(await env.DB.prepare(`SELECT identity_link_id FROM learning_enrollments
      WHERE id = ${graph.enrollmentId}`).first<number>('identity_link_id')).toBe(graph.identityId);
  });

  it('locks an event subject against identity Person reassignment', async () => {
    const graph = await seedGraph(491);
    const alternatePersonId = 4918;
    await addPerson(alternatePersonId);
    await insertSubjectEvent(graph, 'event-subject-person-update');

    await reject(`UPDATE learning_identity_links SET person_id = ${alternatePersonId}
      WHERE id = ${graph.identityId}`);
    expect(await env.DB.prepare(`SELECT person_id FROM learning_identity_links
      WHERE id = ${graph.identityId}`).first<number>('person_id')).toBe(graph.personId);
  });

  it('rejects direct active enrollment deletion without erasing its event', async () => {
    const graph = await seedGraph(492);
    await insertSubjectEvent(graph, 'event-subject-enrollment-delete');

    await reject(`DELETE FROM learning_enrollments WHERE id = ${graph.enrollmentId}`);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM learning_activity_events
      WHERE id = 'event-subject-enrollment-delete'`).first<number>('n')).toBe(1);
  });

  it('rejects direct active identity-link deletion without erasing its event', async () => {
    const graph = await seedGraph(493);
    await insertSubjectEvent(graph, 'event-subject-identity-delete');

    await reject(`DELETE FROM learning_identity_links WHERE id = ${graph.identityId}`);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM learning_activity_events
      WHERE id = 'event-subject-identity-delete'`).first<number>('n')).toBe(1);
  });

  it('binds compatible normalized events to an enrollment and retains them append-only while active', async () => {
    const graph = await seedGraph(500);
    const otherGraph = await seedGraph(501);
    const quizGraph = await seedGraph(502, 'canvas', 'quiz');
    const materialGraph = await seedGraph(503, 'canvas', 'material');
    await env.DB.prepare(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, activity_kind, enrollment_id, status)
      VALUES (${graph.courseId}, ${graph.activityId}, 'assignment', ${graph.enrollmentId}, 'submitted')`).run();
    await env.DB.prepare(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-500-a', ${graph.connectionId}, 'canvas', 'source-500', 'assignment_submitted',
        ${graph.personId}, ${graph.identityId}, ${graph.enrollmentId}, ${graph.courseId},
        ${graph.activityId}, 'assignment',
        '2026-08-16 11:00:00')`).run();
    await env.DB.prepare(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-502-a', ${quizGraph.connectionId}, 'canvas', 'source-502-a', 'quiz_submitted',
        ${quizGraph.personId}, ${quizGraph.identityId}, ${quizGraph.enrollmentId},
        ${quizGraph.courseId}, ${quizGraph.activityId}, 'quiz',
        '2026-08-16 11:00:00')`).run();
    await env.DB.prepare(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-503-a', ${materialGraph.connectionId}, 'canvas', 'source-503-a', 'resource_opened',
        ${materialGraph.personId}, ${materialGraph.identityId}, ${materialGraph.enrollmentId},
        ${materialGraph.courseId}, ${materialGraph.activityId}, 'material',
        '2026-08-16 11:00:00')`).run();
    await env.DB.prepare(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, occurred_at)
      VALUES ('event-500-enrolled', ${graph.connectionId}, 'canvas', 'source-500-enrolled', 'enrolled',
        ${graph.personId}, ${graph.identityId}, ${graph.enrollmentId}, ${graph.courseId},
        '2026-08-16 11:00:00')`).run();
    expect(await env.DB.prepare(`SELECT event_type, length(ingested_at) AS ingested_length
      FROM learning_activity_events WHERE id = 'event-500-a'`).first()).toEqual({
      event_type: 'assignment_submitted',
      ingested_length: 19,
    });

    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-500-b', ${graph.connectionId}, 'canvas', 'source-500', 'assignment_submitted',
        ${graph.personId}, ${graph.identityId}, ${graph.enrollmentId}, ${graph.courseId},
        ${graph.activityId}, 'assignment',
        '2026-08-16 11:00:01')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       course_id, occurred_at)
      VALUES ('event-500-c', ${graph.connectionId}, 'canvas', 'source-501', 'assignment_submitted',
        ${graph.personId}, ${graph.identityId}, ${graph.courseId}, '2026-08-16 11:00:02')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-500-missing-enrollment', ${graph.connectionId}, 'canvas', 'source-501-missing',
        'assignment_submitted', ${graph.personId}, ${graph.identityId}, ${graph.enrollmentId + 99},
        ${graph.courseId}, ${graph.activityId}, 'assignment', '2026-08-16 11:00:02')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-500-d', ${graph.connectionId}, 'canvas', 'source-502', 'enrolled',
        ${graph.personId}, ${graph.identityId}, ${graph.enrollmentId}, ${graph.courseId},
        ${graph.activityId}, 'assignment',
        '2026-08-16 11:00:03')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-500-e', ${graph.connectionId}, 'canvas', 'source-503', 'graded',
        ${graph.personId}, ${graph.identityId}, ${graph.enrollmentId}, ${graph.courseId},
        ${graph.activityId}, 'assignment',
        '2026-08-16 11:00:04')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-500-f', ${graph.connectionId}, 'canvas', 'source-504', 'assignment_submitted',
        ${graph.personId}, ${graph.identityId}, ${graph.enrollmentId}, ${graph.courseId},
        ${otherGraph.activityId}, 'assignment',
        '2026-08-16 11:00:05')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-500-cross-enrollment', ${graph.connectionId}, 'canvas', 'source-505',
        'assignment_submitted', ${graph.personId}, ${graph.identityId}, ${otherGraph.enrollmentId},
        ${graph.courseId}, ${graph.activityId}, 'assignment', '2026-08-16 11:00:06')`);
    for (const [eventType, activityKind] of [
      ['assignment_submitted', 'quiz'],
      ['quiz_submitted', 'assignment'],
      ['submission_returned', 'material'],
    ]) {
      await reject(`INSERT INTO learning_activity_events
        (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
         enrollment_id, course_id, activity_id, activity_kind, occurred_at)
        VALUES ('event-500-${eventType}', ${graph.connectionId}, 'canvas',
          'source-500-${eventType}', '${eventType}', ${graph.personId}, ${graph.identityId},
          ${graph.enrollmentId}, ${graph.courseId}, ${graph.activityId}, '${activityKind}',
          '2026-08-16 11:00:07')`);
    }
    await reject(`UPDATE learning_activity_events SET occurred_at = '2026-08-16 12:00:00'
      WHERE id = 'event-500-a'`);
    await reject("DELETE FROM learning_activity_events WHERE id = 'event-500-a'");

    await env.DB.prepare(`UPDATE learning_courses SET lifecycle_state = 'archived',
      deleted_at = '2026-08-16 12:00:00' WHERE id = ${graph.courseId}`).run();
    await env.DB.prepare("DELETE FROM learning_activity_events WHERE id = 'event-500-a'").run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM learning_activity_events WHERE id = 'event-500-a'")
      .first<number>('n')).toBe(0);
    await env.DB.prepare(`DELETE FROM learning_activity_events
      WHERE enrollment_id = ${graph.enrollmentId}`).run();
    await env.DB.prepare(`DELETE FROM learning_enrollments WHERE id = ${graph.enrollmentId}`).run();
    await env.DB.prepare(`DELETE FROM learning_identity_links WHERE id = ${graph.identityId}`).run();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM learning_enrollments
      WHERE id = ${graph.enrollmentId}`).first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM learning_identity_links
      WHERE id = ${graph.identityId}`).first<number>('n')).toBe(0);
  });

  it('allows parent cascades but rejects direct active activity deletion until a parent is retired', async () => {
    const personGraph = await seedGraph(510);
    await env.DB.prepare(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-510-a', ${personGraph.connectionId}, 'canvas', 'source-510-a',
        'assignment_submitted', ${personGraph.personId}, ${personGraph.identityId},
        ${personGraph.enrollmentId}, ${personGraph.courseId}, ${personGraph.activityId},
        'assignment', '2026-08-16 11:00:00')`).run();
    await env.DB.prepare(`DELETE FROM people WHERE id = ${personGraph.personId}`).run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM learning_activity_events WHERE id = 'event-510-a'")
      .first<number>('n')).toBe(0);

    const courseGraph = await seedGraph(511);
    await env.DB.prepare(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, identity_link_id,
       enrollment_id, course_id, activity_id, activity_kind, occurred_at)
      VALUES ('event-511-a', ${courseGraph.connectionId}, 'canvas', 'source-511-a',
        'assignment_submitted', ${courseGraph.personId}, ${courseGraph.identityId},
        ${courseGraph.enrollmentId}, ${courseGraph.courseId}, ${courseGraph.activityId},
        'assignment', '2026-08-16 11:00:00')`).run();
    await env.DB.prepare(`DELETE FROM learning_courses WHERE id = ${courseGraph.courseId}`).run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM learning_activity_events WHERE id = 'event-511-a'")
      .first<number>('n')).toBe(0);

    const directGraph = await seedGraph(512);
    await reject(`DELETE FROM learning_activities WHERE id = ${directGraph.activityId}`);
    await env.DB.prepare(`UPDATE learning_provider_connections
      SET status = 'disabled', deleted_at = '2026-08-16 12:00:00'
      WHERE id = ${directGraph.connectionId}`).run();
    await env.DB.prepare(`DELETE FROM learning_activities WHERE id = ${directGraph.activityId}`).run();
  });

  it('bounds sync-run triggers, statuses, error codes, counts, attempts, and completion timestamps', async () => {
    const graph = await seedGraph(600);
    await env.DB.prepare(`INSERT INTO learning_sync_runs
      (id, connection_id, course_id, trigger_type, status)
      VALUES (6008, ${graph.connectionId}, ${graph.courseId}, 'manual', 'running')`).run();
    expect(await env.DB.prepare(`SELECT trigger_type, status, attempt_count, scanned_count,
      changed_count, removed_count, event_count, length(started_at) AS started_length
      FROM learning_sync_runs WHERE id = 6008`).first()).toEqual({
      trigger_type: 'manual',
      status: 'running',
      attempt_count: 1,
      scanned_count: 0,
      changed_count: 0,
      removed_count: 0,
      event_count: 0,
      started_length: 19,
    });

    for (const values of [
      `(${graph.connectionId}, ${graph.courseId}, 'webhook', 'running', NULL, NULL, 1, 0)`,
      `(${graph.connectionId}, ${graph.courseId}, 'manual', 'complete', '2026-08-16 12:00:00', NULL, 1, 0)`,
      `(${graph.connectionId}, ${graph.courseId}, 'scheduled', 'succeeded', NULL, NULL, 1, 0)`,
      `(${graph.connectionId}, ${graph.courseId}, 'notification', 'failed', '2026-08-16 12:00:00', NULL, 1, 0)`,
      `(${graph.connectionId}, ${graph.courseId}, 'notification', 'failed', '2026-08-16 12:00:00', 'UPSTREAM SECRET', 1, 0)`,
      `(${graph.connectionId}, ${graph.courseId}, 'manual', 'cancelled', '2026-08-16 12:00:00', NULL, 0, 0)`,
      `(${graph.connectionId}, ${graph.courseId}, 'manual', 'cancelled', '2026-08-16 12:00:00', NULL, 11, 0)`,
      `(${graph.connectionId}, ${graph.courseId}, 'manual', 'cancelled', '2026-08-16 12:00:00', NULL, 1, 100001)`,
    ]) {
      await reject(`INSERT INTO learning_sync_runs
        (connection_id, course_id, trigger_type, status, finished_at, error_code, attempt_count,
         scanned_count) VALUES ${values}`);
    }

    await env.DB.prepare(`INSERT INTO learning_sync_runs
      (id, connection_id, course_id, trigger_type, status, finished_at, error_code,
       attempt_count, scanned_count, changed_count, removed_count, event_count)
      VALUES (6009, ${graph.connectionId}, ${graph.courseId}, 'notification', 'failed',
        '2026-08-16 12:00:00', 'provider_rate_limited', 3, 100000, 99999, 1, 100000)`).run();

    for (const [column, value] of [
      ['attempt_count', '1.5'],
      ['scanned_count', '0.5'],
      ['changed_count', '0.5'],
      ['removed_count', '0.5'],
      ['event_count', '0.5'],
      ['changed_count', '100001'],
      ['removed_count', '100001'],
      ['event_count', '100001'],
    ]) {
      await reject(`UPDATE learning_sync_runs SET ${column} = ${value} WHERE id = 6009`);
    }
  });
});
