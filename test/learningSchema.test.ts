import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const LEARNING_TABLES = [
  'learning_activities',
  'learning_activity_events',
  'learning_courses',
  'learning_enrollments',
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
  'idx_learning_connections_active_sync',
  'idx_learning_courses_connection_sync',
  'idx_learning_courses_program_state',
  'idx_learning_enrollments_course_state',
  'idx_learning_enrollments_identity_state',
  'idx_learning_events_activity_time',
  'idx_learning_events_connection_ingested',
  'idx_learning_events_course_time',
  'idx_learning_events_person_time',
  'idx_learning_identities_person_status',
  'idx_learning_programs_active_name',
  'idx_learning_resources_activity_kind',
  'idx_learning_snapshots_course_state',
  'idx_learning_snapshots_enrollment_state',
  'idx_learning_sync_runs_connection_time',
  'idx_learning_sync_runs_course_time',
  'idx_learning_sync_runs_status_time',
] as const;

async function reject(statement: string): Promise<void> {
  await expect(env.DB.prepare(statement).run()).rejects.toThrow();
}

async function columns(table: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results.map((column) => column.name);
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

async function seedGraph(seed: number, provider: 'google_classroom' | 'canvas' = 'canvas'): Promise<SeededGraph> {
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
      VALUES (${activityId}, ${courseId}, 'activity-${seed}', 'Activity ${seed}', 'assignment',
        'published', 'https://courses-${seed}.example.test/activity')`),
  ]);

  return { connectionId, programId, courseId, identityId, enrollmentId, activityId, personId };
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
      'course_id', 'activity_id', 'enrollment_id', 'status', 'late', 'attempt_number',
      'submitted_at', 'returned_at', 'provider_updated_at', 'synced_at',
    ]);
    expect(await columns('learning_activity_events')).toEqual([
      'id', 'connection_id', 'provider', 'source_event_id', 'event_type', 'person_id',
      'course_id', 'activity_id', 'occurred_at', 'ingested_at',
    ]);

    const forbidden = /(?:access|refresh)_token|oauth_code|client_secret|plaintext|payload|homework|answer|comment|grade|rubric|file_bytes|content/i;
    for (const table of [
      'learning_provider_credentials',
      'learning_submission_snapshots',
      'learning_activity_events',
    ]) {
      expect((await columns(table)).filter((column) => forbidden.test(column))).toEqual([]);
    }
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

    const other = await seedGraph(201);
    for (const values of [
      `(${other.connectionId}, zeroblob(15), zeroblob(12), 'AES-256-GCM', 1, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(11), 'AES-256-GCM', 1, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(12), 'AES-CBC', 1, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(12), 'AES-256-GCM', 0, 1)`,
      `(${other.connectionId}, zeroblob(32), zeroblob(12), 'AES-256-GCM', 1, 2)`,
    ]) {
      await reject(`INSERT INTO learning_provider_credentials
        (connection_id, ciphertext, nonce, algorithm, key_version, envelope_version) VALUES ${values}`);
    }
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
    await env.DB.prepare(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, enrollment_id, status, late, attempt_number, submitted_at,
       provider_updated_at)
      VALUES (${graph.courseId}, ${graph.activityId}, ${graph.enrollmentId}, 'submitted', 1, 2,
        '2026-08-16 10:00:00', '2026-08-16 10:01:00')`).run();
    expect(await env.DB.prepare(`SELECT status, late, attempt_number, length(synced_at) AS synced_length
      FROM learning_submission_snapshots WHERE activity_id = ${graph.activityId}`).first()).toEqual({
      status: 'submitted',
      late: 1,
      attempt_number: 2,
      synced_length: 19,
    });

    await reject(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, enrollment_id, status)
      VALUES (${graph.courseId}, ${graph.activityId}, ${graph.enrollmentId}, 'submitted')`);
    await reject(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, enrollment_id, status, late, attempt_number)
      VALUES (${graph.courseId}, ${graph.activityId}, ${graph.enrollmentId + 99}, 'submitted', 0, 1)`);
    await reject(`UPDATE learning_submission_snapshots SET status = 'graded'
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
    await reject(`UPDATE learning_submission_snapshots SET late = 2
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
    await reject(`UPDATE learning_submission_snapshots SET attempt_number = 1001
      WHERE activity_id = ${graph.activityId} AND enrollment_id = ${graph.enrollmentId}`);
  });

  it('deduplicates append-only normalized events without payload or content carriers', async () => {
    const graph = await seedGraph(500);
    const otherGraph = await seedGraph(501);
    await env.DB.prepare(`INSERT INTO learning_submission_snapshots
      (course_id, activity_id, enrollment_id, status)
      VALUES (${graph.courseId}, ${graph.activityId}, ${graph.enrollmentId}, 'submitted')`).run();
    await env.DB.prepare(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, course_id, activity_id,
       occurred_at)
      VALUES ('event-500-a', ${graph.connectionId}, 'canvas', 'source-500', 'assignment_submitted',
        ${graph.personId}, ${graph.courseId}, ${graph.activityId}, '2026-08-16 11:00:00')`).run();
    expect(await env.DB.prepare(`SELECT event_type, length(ingested_at) AS ingested_length
      FROM learning_activity_events WHERE id = 'event-500-a'`).first()).toEqual({
      event_type: 'assignment_submitted',
      ingested_length: 19,
    });

    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, course_id, activity_id,
       occurred_at)
      VALUES ('event-500-b', ${graph.connectionId}, 'canvas', 'source-500', 'assignment_submitted',
        ${graph.personId}, ${graph.courseId}, ${graph.activityId}, '2026-08-16 11:00:01')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, course_id, occurred_at)
      VALUES ('event-500-c', ${graph.connectionId}, 'canvas', 'source-501', 'assignment_submitted',
        ${graph.personId}, ${graph.courseId}, '2026-08-16 11:00:02')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, course_id, activity_id,
       occurred_at)
      VALUES ('event-500-d', ${graph.connectionId}, 'canvas', 'source-502', 'enrolled',
        ${graph.personId}, ${graph.courseId}, ${graph.activityId}, '2026-08-16 11:00:03')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, course_id, activity_id,
       occurred_at)
      VALUES ('event-500-e', ${graph.connectionId}, 'canvas', 'source-503', 'graded',
        ${graph.personId}, ${graph.courseId}, ${graph.activityId}, '2026-08-16 11:00:04')`);
    await reject(`INSERT INTO learning_activity_events
      (id, connection_id, provider, source_event_id, event_type, person_id, course_id, activity_id,
       occurred_at)
      VALUES ('event-500-f', ${graph.connectionId}, 'canvas', 'source-504', 'assignment_submitted',
        ${graph.personId}, ${graph.courseId}, ${otherGraph.activityId}, '2026-08-16 11:00:05')`);
    await reject(`UPDATE learning_activity_events SET occurred_at = '2026-08-16 12:00:00'
      WHERE id = 'event-500-a'`);
    await reject("DELETE FROM learning_activity_events WHERE id = 'event-500-a'");

    await env.DB.prepare(`DELETE FROM people WHERE id = ${graph.personId}`).run();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM learning_activity_events WHERE id = 'event-500-a'")
      .first<number>('n')).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM learning_submission_snapshots
      WHERE enrollment_id = ${graph.enrollmentId}`).first<number>('n')).toBe(0);
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
  });
});
