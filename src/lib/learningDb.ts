import type { AppDb, AppDbResult, AppStatement } from './appDb';
import {
  LEARNING_ERROR_CODES,
  LEARNING_LIMITS,
  learningValidation,
  normalizeLearningActivity,
  normalizeLearningConnectionUrlPolicy,
  normalizeLearningCourse,
  normalizeLearningProviderEnrollment,
  normalizeLearningProviderSubmission,
  normalizeLearningResource,
  type LearningActivity,
  type LearningConnectionUrlPolicy,
  type LearningErrorCode,
  type LearningProviderEnrollment,
  type LearningProviderKind,
  type LearningProviderSubmission,
  type LearningResource,
  type LearningSyncTrigger,
} from './learningModel';

export class LearningPersistenceError extends Error {
  readonly code = 'learning_persistence_failed' as const;
  constructor() { super('learning_persistence_failed'); this.name = 'LearningPersistenceError'; }
}

export class LearningIdentityConflictError extends Error {
  readonly code = 'learning_identity_conflict' as const;
  constructor() { super('learning_identity_conflict'); this.name = 'LearningIdentityConflictError'; }
}

export class LearningSyncConflictError extends Error {
  readonly code = 'learning_sync_conflict' as const;
  constructor() { super('learning_sync_conflict'); this.name = 'LearningSyncConflictError'; }
}

const persistenceFailure = (): never => { throw new LearningPersistenceError(); };
const invalid = (): never => { throw new LearningPersistenceError(); };

function integer(value: unknown, minimum: number = 1, maximum: number = LEARNING_LIMITS.databaseInteger): number {
  try { return learningValidation.integer(value, minimum, maximum); } catch { return invalid(); }
}

function timestamp(value: unknown): string {
  try { return learningValidation.timestamp(value); } catch { return invalid(); }
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try { return learningValidation.exactRecord(value, keys); } catch { return invalid(); }
}

function array(value: unknown, maximum: number): readonly unknown[] {
  try { return learningValidation.dataArray(value, maximum); } catch { return invalid(); }
}

function provider(value: unknown): LearningProviderKind {
  try { return learningValidation.oneOf(value, ['google_classroom', 'canvas'] as const); } catch { return invalid(); }
}

function trigger(value: unknown): LearningSyncTrigger {
  try { return learningValidation.oneOf(value, ['manual', 'scheduled', 'notification'] as const); } catch { return invalid(); }
}

function errorCode(value: unknown): LearningErrorCode {
  try { return learningValidation.oneOf(value, LEARNING_ERROR_CODES); } catch { return invalid(); }
}

function bounded(value: unknown, maximum: number): string {
  try { return learningValidation.boundedString(value, 1, maximum); } catch { return invalid(); }
}

function externalId(value: unknown): string {
  try { return learningValidation.externalId(value); } catch { return invalid(); }
}

function resultRows(result: AppDbResult<unknown> | undefined, maximum: number): readonly Record<string, unknown>[] {
  if (!result || !Array.isArray(result.results) || result.results.length > maximum) persistenceFailure();
  const rows = result?.results;
  if (!rows) return persistenceFailure();
  return rows.map((item) => {
    if (!item || typeof item !== 'object') return persistenceFailure();
    return item as Record<string, unknown>;
  });
}

function oneRow(result: AppDbResult<unknown> | undefined): Record<string, unknown> | null {
  const rows = resultRows(result, 1);
  return rows.length === 0 ? null : rows[0];
}

export interface LearningProgramRecord {
  readonly programId: number;
  readonly slug: string;
  readonly displayName: string;
  readonly status: 'active' | 'archived';
}

function programRow(value: Record<string, unknown>): LearningProgramRecord {
  const status = value.status;
  if (status !== 'active' && status !== 'archived') persistenceFailure();
  return Object.freeze({
    programId: integer(value.program_id),
    slug: bounded(value.slug, 64),
    displayName: bounded(value.display_name, 200),
    status: status as LearningProgramRecord['status'],
  });
}

export async function createLearningProgram(
  db: AppDb,
  rawInput: { readonly slug: string; readonly displayName: string; readonly actorPersonId: number },
): Promise<LearningProgramRecord> {
  const input = exact(rawInput, ['slug', 'displayName', 'actorPersonId']);
  const slug = bounded(input.slug, 64);
  if (!/^[a-z][a-z0-9-]*$/u.test(slug)) invalid();
  const displayName = bounded(input.displayName, 200);
  const actor = integer(input.actorPersonId);
  try {
    const row = await db.prepare(`INSERT INTO learning_programs
      (slug,display_name,status,created_by_person_id,updated_by_person_id,created_at,updated_at)
      VALUES (?1,?2,'active',?3,?3,datetime('now'),datetime('now'))
      RETURNING id AS program_id,slug,display_name,status`)
      .bind(slug, displayName, actor).run();
    const created = oneRow(row);
    return created ? programRow(created) : persistenceFailure();
  } catch (error) {
    if (error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export interface LearningMappedCourseRecord {
  readonly courseId: number;
  readonly programId: number;
  readonly connectionId: number;
  readonly provider: LearningProviderKind;
  readonly externalCourseId: string;
  readonly displayName: string;
  readonly lifecycleState: 'active' | 'archived' | 'deleted';
  readonly lastSyncedAt: string | null;
}

function mappedCourseRow(value: Record<string, unknown>): LearningMappedCourseRecord {
  const kind = provider(value.provider);
  const lifecycleState = value.lifecycle_state;
  if (lifecycleState !== 'active' && lifecycleState !== 'archived' && lifecycleState !== 'deleted') persistenceFailure();
  if (value.last_synced_at !== null && typeof value.last_synced_at !== 'string') persistenceFailure();
  return Object.freeze({
    courseId: integer(value.course_id), programId: integer(value.program_id),
    connectionId: integer(value.connection_id), provider: kind,
    externalCourseId: externalId(value.external_course_id),
    displayName: bounded(value.display_name, LEARNING_LIMITS.courseDisplayNameBytes),
    lifecycleState: lifecycleState as LearningMappedCourseRecord['lifecycleState'],
    lastSyncedAt: value.last_synced_at as string | null,
  });
}

export async function mapLearningCourse(
  db: AppDb,
  rawInput: {
    readonly programId: number;
    readonly course: unknown;
    readonly urlPolicy: LearningConnectionUrlPolicy;
  },
): Promise<LearningMappedCourseRecord> {
  const input = exact(rawInput, ['programId', 'course', 'urlPolicy']);
  const programId = integer(input.programId);
  let policy: LearningConnectionUrlPolicy;
  let course;
  try {
    policy = normalizeLearningConnectionUrlPolicy(input.urlPolicy);
    course = normalizeLearningCourse(input.course, policy);
  } catch { return invalid(); }
  try {
    const result = await db.prepare(`INSERT INTO learning_courses
      (program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state,
       provider_updated_at,last_synced_at,created_at,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,datetime('now'),datetime('now')
      FROM learning_programs p JOIN learning_provider_connections c ON c.id=?2
      WHERE p.id=?1 AND p.status='active' AND p.deleted_at IS NULL
        AND c.provider=?3 AND c.status='active' AND c.deleted_at IS NULL
      ON CONFLICT(connection_id,external_course_id) DO NOTHING
      RETURNING id AS course_id,program_id,connection_id,provider,external_course_id,
        display_name,lifecycle_state,last_synced_at`)
      .bind(
        programId, course.connectionId, course.provider, course.externalCourseId, course.displayName,
        course.launchUrl, course.lifecycleState, course.providerUpdatedAt, course.lastSyncedAt,
      ).run();
    const created = oneRow(result);
    if (!created) persistenceFailure();
    return mappedCourseRow(created as Record<string, unknown>);
  } catch (error) {
    if (error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export interface LearningIdentityRecord {
  readonly identityLinkId: number;
  readonly connectionId: number;
  readonly personId: number;
  readonly externalUserId: string;
  readonly status: 'active' | 'disabled' | 'conflict';
}

function identityRow(value: Record<string, unknown>): LearningIdentityRecord {
  const status = value.status;
  if (status !== 'active' && status !== 'disabled' && status !== 'conflict') persistenceFailure();
  return Object.freeze({
    identityLinkId: integer(value.identity_link_id), connectionId: integer(value.connection_id),
    personId: integer(value.person_id), externalUserId: externalId(value.external_user_id),
    status: status as LearningIdentityRecord['status'],
  });
}

export async function linkLearningIdentity(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly provider: LearningProviderKind;
    readonly externalUserId: string;
    readonly personId: number;
  },
): Promise<LearningIdentityRecord> {
  const input = exact(rawInput, ['connectionId', 'provider', 'externalUserId', 'personId']);
  const connectionId = integer(input.connectionId);
  const kind = provider(input.provider);
  const externalUserId = externalId(input.externalUserId);
  const personId = integer(input.personId);
  try {
    const results = await db.batch([
      db.prepare(`INSERT INTO learning_identity_links
        (connection_id,person_id,external_user_id,status,created_at,updated_at)
        SELECT c.id,?1,?2,'active',datetime('now'),datetime('now')
        FROM learning_provider_connections c JOIN people p ON p.id=?1
        WHERE c.id=?3 AND c.provider=?4 AND c.deleted_at IS NULL AND c.operation_marker IS NULL
        ON CONFLICT DO NOTHING`).bind(personId, externalUserId, connectionId, kind),
      db.prepare(`SELECT i.id AS identity_link_id,i.connection_id,i.person_id,i.external_user_id,i.status
        FROM learning_identity_links i JOIN learning_provider_connections c ON c.id=i.connection_id
        WHERE i.connection_id=?1 AND c.provider=?4 AND (i.external_user_id=?2 OR i.person_id=?3)
        ORDER BY i.id LIMIT 2`).bind(connectionId, externalUserId, personId, kind),
    ]);
    if (!Array.isArray(results) || results.length !== 2) persistenceFailure();
    const rows = resultRows(results[1], 2);
    const matching = rows.find((row) => row.external_user_id === externalUserId && row.person_id === personId);
    if (matching && rows.length === 1) return identityRow(matching);
    if (rows.length > 0) throw new LearningIdentityConflictError();
    return persistenceFailure();
  } catch (error) {
    if (error instanceof LearningIdentityConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export interface LearningSyncLease {
  readonly runId: number;
  readonly marker: string;
  readonly connectionId: number;
  readonly provider: LearningProviderKind;
  readonly courseId: number;
  readonly externalCourseId: string;
  readonly trigger: LearningSyncTrigger;
  readonly startedAt: string;
}

function lease(value: unknown): LearningSyncLease {
  const row = exact(value, [
    'runId', 'marker', 'connectionId', 'provider', 'courseId', 'externalCourseId', 'trigger', 'startedAt',
  ]);
  const markerValue = row.marker;
  if (typeof markerValue !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(markerValue)) invalid();
  const marker = markerValue as string;
  return Object.freeze({
    runId: integer(row.runId), marker, connectionId: integer(row.connectionId),
    provider: provider(row.provider), courseId: integer(row.courseId),
    externalCourseId: externalId(row.externalCourseId), trigger: trigger(row.trigger),
    startedAt: timestamp(row.startedAt),
  });
}

export async function startLearningSync(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly provider: LearningProviderKind;
    readonly courseId: number;
    readonly externalCourseId: string;
    readonly trigger: LearningSyncTrigger;
    readonly startedAt: string;
  },
): Promise<LearningSyncLease> {
  const input = exact(rawInput, [
    'connectionId', 'provider', 'courseId', 'externalCourseId', 'trigger', 'startedAt',
  ]);
  const connectionId = integer(input.connectionId);
  const kind = provider(input.provider);
  const courseId = integer(input.courseId);
  const courseExternalId = externalId(input.externalCourseId);
  const triggerType = trigger(input.trigger);
  const startedAt = timestamp(input.startedAt);
  const marker = crypto.randomUUID();
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=?1
        WHERE id=?2 AND provider=?3 AND status='active' AND deleted_at IS NULL
          AND operation_marker IS NULL AND EXISTS (
            SELECT 1 FROM learning_courses c WHERE c.id=?4 AND c.connection_id=?2
              AND c.provider=?3 AND c.external_course_id=?5 AND c.deleted_at IS NULL
          )`).bind(marker, connectionId, kind, courseId, courseExternalId),
      db.prepare(`INSERT INTO learning_sync_runs
        (connection_id,course_id,trigger_type,status,started_at,attempt_count,
         scanned_count,changed_count,removed_count,event_count,error_code)
        SELECT ?1,?2,?3,'running',?4,1,0,0,0,0,NULL
        WHERE EXISTS (SELECT 1 FROM learning_provider_connections
          WHERE id=?1 AND provider=?5 AND operation_marker=?6)
        RETURNING id AS run_id`).bind(connectionId, courseId, triggerType, startedAt, kind, marker),
    ]);
    if (!Array.isArray(results) || results.length !== 2) persistenceFailure();
    const started = oneRow(results[1]);
    if (!started) throw new LearningSyncConflictError();
    return lease({
      runId: started.run_id, marker, connectionId, provider: kind, courseId,
      externalCourseId: courseExternalId, trigger: triggerType, startedAt,
    });
  } catch (error) {
    if (error instanceof LearningSyncConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export interface ResolvedLearningEnrollment {
  readonly providerEnrollment: LearningProviderEnrollment;
  readonly personId: number;
}

export interface ResolvedLearningSubmission {
  readonly providerSubmission: LearningProviderSubmission;
  readonly personId: number;
}

interface NormalizedSnapshot {
  readonly course: ReturnType<typeof normalizeLearningCourse>;
  readonly urlPolicy: LearningConnectionUrlPolicy;
  readonly syncedAt: string;
  readonly enrollments: readonly ResolvedLearningEnrollment[];
  readonly activities: readonly LearningActivity[];
  readonly resources: readonly LearningResource[];
  readonly submissions: readonly ResolvedLearningSubmission[];
}

function sameCourse(value: { connectionId: number; provider: LearningProviderKind; externalCourseId: string }, own: LearningSyncLease): boolean {
  return value.connectionId === own.connectionId && value.provider === own.provider
    && value.externalCourseId === own.externalCourseId;
}

function normalizedSnapshot(rawValue: unknown, own: LearningSyncLease): NormalizedSnapshot {
  const value = exact(rawValue, [
    'course', 'urlPolicy', 'syncedAt', 'enrollments', 'activities', 'resources', 'submissions',
  ]);
  let urlPolicy: LearningConnectionUrlPolicy;
  let courseValue;
  try {
    urlPolicy = normalizeLearningConnectionUrlPolicy(value.urlPolicy);
    courseValue = normalizeLearningCourse(value.course, urlPolicy);
  } catch { return invalid(); }
  if (!sameCourse(courseValue, own)) invalid();
  const syncedAt = timestamp(value.syncedAt);
  if (Date.parse(syncedAt) < Date.parse(own.startedAt)) invalid();
  const rawEnrollments = array(value.enrollments, LEARNING_LIMITS.maxSyncItems);
  const rawActivities = array(value.activities, LEARNING_LIMITS.maxSyncItems);
  const rawResources = array(value.resources, LEARNING_LIMITS.maxSyncItems);
  const rawSubmissions = array(value.submissions, LEARNING_LIMITS.maxSyncItems);
  if (rawEnrollments.length + rawActivities.length + rawResources.length + rawSubmissions.length > LEARNING_LIMITS.maxSyncItems) invalid();

  const externalUserIds = new Set<string>();
  const externalEnrollmentIds = new Set<string>();
  const personKeys = new Set<number>();
  const enrollments = rawEnrollments.map((candidate) => {
    const row = exact(candidate, ['providerEnrollment', 'personId']);
    let providerEnrollment: LearningProviderEnrollment;
    try { providerEnrollment = normalizeLearningProviderEnrollment(row.providerEnrollment); } catch { return invalid(); }
    const personId = integer(row.personId);
    if (!sameCourse(providerEnrollment, own)) invalid();
    if (externalUserIds.has(providerEnrollment.externalUserId)
      || externalEnrollmentIds.has(providerEnrollment.externalEnrollmentId)) invalid();
    if (personKeys.has(personId)) invalid();
    externalUserIds.add(providerEnrollment.externalUserId);
    externalEnrollmentIds.add(providerEnrollment.externalEnrollmentId);
    personKeys.add(personId);
    return Object.freeze({ providerEnrollment, personId });
  });
  const enrollmentByExternalId = new Map(enrollments.map((item) => [item.providerEnrollment.externalEnrollmentId, item]));

  const activityIds = new Set<string>();
  const activities = rawActivities.map((candidate) => {
    let item: LearningActivity;
    try { item = normalizeLearningActivity(candidate, urlPolicy); } catch { return invalid(); }
    if (!sameCourse(item, own) || activityIds.has(item.externalActivityId)) invalid();
    activityIds.add(item.externalActivityId);
    return item;
  });
  const activityById = new Map(activities.map((item) => [item.externalActivityId, item]));

  const resourceIds = new Set<string>();
  const resources = rawResources.map((candidate) => {
    let item: LearningResource;
    try { item = normalizeLearningResource(candidate, urlPolicy); } catch { return invalid(); }
    if (!sameCourse(item, own) || !activityIds.has(item.externalActivityId)) invalid();
    const key = `${item.externalActivityId}\u0000${item.externalResourceId}`;
    if (resourceIds.has(key)) invalid();
    resourceIds.add(key);
    return item;
  });

  const submissionIds = new Set<string>();
  const submissions = rawSubmissions.map((candidate) => {
    const row = exact(candidate, ['providerSubmission', 'personId']);
    let providerSubmission: LearningProviderSubmission;
    try { providerSubmission = normalizeLearningProviderSubmission(row.providerSubmission); } catch { return invalid(); }
    const personId = integer(row.personId);
    const linkedEnrollment = enrollmentByExternalId.get(providerSubmission.externalEnrollmentId);
    const linkedActivity = activityById.get(providerSubmission.externalActivityId);
    if (!sameCourse(providerSubmission, own)
      || !linkedEnrollment || linkedEnrollment.personId !== personId
      || linkedEnrollment.providerEnrollment.externalUserId !== providerSubmission.externalUserId
      || !linkedActivity || (linkedActivity.kind !== 'assignment' && linkedActivity.kind !== 'quiz')) invalid();
    const key = `${providerSubmission.externalActivityId}\u0000${providerSubmission.externalEnrollmentId}`;
    if (submissionIds.has(key)) invalid();
    submissionIds.add(key);
    return Object.freeze({ providerSubmission, personId });
  });
  return Object.freeze({
    course: courseValue, urlPolicy, syncedAt,
    enrollments: Object.freeze(enrollments), activities: Object.freeze(activities),
    resources: Object.freeze(resources), submissions: Object.freeze(submissions),
  });
}

async function hashEvent(parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sync_${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

interface PendingEvent {
  readonly sourceEventId: string;
  readonly eventType: 'enrolled' | 'course_completed' | 'assignment_submitted' | 'quiz_submitted' | 'submission_returned';
  readonly externalEnrollmentId: string;
  readonly externalActivityId: string | null;
  readonly activityKind: 'assignment' | 'quiz' | null;
  readonly occurredAt: string;
}

async function eventsFor(snapshot: NormalizedSnapshot, own: LearningSyncLease): Promise<readonly PendingEvent[]> {
  const events: PendingEvent[] = [];
  for (const item of snapshot.enrollments) {
    const enrollment = item.providerEnrollment;
    const eventType = enrollment.state === 'active' ? 'enrolled'
      : enrollment.state === 'completed' ? 'course_completed' : null;
    if (!eventType) continue;
    const sourceEventId = await hashEvent([
      own.provider, String(own.connectionId), own.externalCourseId,
      enrollment.externalEnrollmentId, eventType,
    ]);
    events.push(Object.freeze({
      sourceEventId, eventType, externalEnrollmentId: enrollment.externalEnrollmentId,
      externalActivityId: null, activityKind: null, occurredAt: snapshot.syncedAt,
    }));
  }
  const activityById = new Map(snapshot.activities.map((item) => [item.externalActivityId, item]));
  for (const item of snapshot.submissions) {
    const submission = item.providerSubmission;
    if (submission.status !== 'submitted' && submission.status !== 'returned') continue;
    const candidateActivity = activityById.get(submission.externalActivityId);
    if (!candidateActivity || (candidateActivity.kind !== 'assignment' && candidateActivity.kind !== 'quiz')) invalid();
    const activity = candidateActivity as LearningActivity & { readonly kind: 'assignment' | 'quiz' };
    const eventType = submission.status === 'returned' ? 'submission_returned'
      : activity.kind === 'quiz' ? 'quiz_submitted' : 'assignment_submitted';
    const occurredAt = submission.status === 'returned'
      ? submission.returnedAt as string : submission.submittedAt as string;
    const sourceEventId = await hashEvent([
      own.provider, String(own.connectionId), own.externalCourseId,
      submission.externalActivityId, submission.externalEnrollmentId,
      eventType, submission.providerUpdatedAt ?? occurredAt,
    ]);
    events.push(Object.freeze({
      sourceEventId, eventType, externalEnrollmentId: submission.externalEnrollmentId,
      externalActivityId: submission.externalActivityId, activityKind: activity.kind, occurredAt,
    }));
  }
  return Object.freeze(events);
}

function leaseGuard(db: AppDb, own: LearningSyncLease): AppStatement {
  // A lost/forged lease deliberately violates the revision CHECK so the entire
  // AppDb batch rolls back on both SQLite/D1 and PostgreSQL.
  return db.prepare(`UPDATE learning_provider_connections SET revision=-1
    WHERE id=?1 AND (operation_marker IS NULL OR operation_marker<>?2)`).bind(own.connectionId, own.marker);
}

async function assertIdentityMappings(
  db: AppDb,
  own: LearningSyncLease,
  enrollments: readonly ResolvedLearningEnrollment[],
): Promise<void> {
  if (enrollments.length === 0) return;
  try {
    const chunkSize = 40;
    for (let start = 0; start < enrollments.length; start += chunkSize) {
      const chunk = enrollments.slice(start, start + chunkSize);
      const userPlaceholders = chunk.map((_, index) => `?${index + 2}`).join(',');
      const personOffset = chunk.length + 2;
      const personPlaceholders = chunk.map((_, index) => `?${personOffset + index}`).join(',');
      const values = [
        own.connectionId,
        ...chunk.map((item) => item.providerEnrollment.externalUserId),
        ...chunk.map((item) => item.personId),
      ];
      const result = await db.prepare(`SELECT person_id,external_user_id FROM learning_identity_links
        WHERE connection_id=?1 AND (
          external_user_id IN (${userPlaceholders}) OR person_id IN (${personPlaceholders})
        ) ORDER BY id`).bind(...values).all();
      const rows = resultRows(result, chunk.length * 2);
      for (const enrollment of chunk) {
        const conflict = rows.find((row) => (
          row.external_user_id === enrollment.providerEnrollment.externalUserId
          || row.person_id === enrollment.personId
        ) && !(
          row.external_user_id === enrollment.providerEnrollment.externalUserId
          && row.person_id === enrollment.personId
        ));
        if (conflict) throw new LearningIdentityConflictError();
      }
    }
  } catch (error) {
    if (error instanceof LearningIdentityConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export interface LearningSyncCompletion {
  readonly runId: number;
  readonly status: 'succeeded';
  readonly scannedCount: number;
  readonly eventCount: number;
}

export async function completeLearningCourseSync(
  db: AppDb,
  rawLease: LearningSyncLease,
  rawSnapshot: unknown,
): Promise<LearningSyncCompletion> {
  const own = lease(rawLease);
  const snapshot = normalizedSnapshot(rawSnapshot, own);
  await assertIdentityMappings(db, own, snapshot.enrollments);
  const events = await eventsFor(snapshot, own);
  const statements: AppStatement[] = [leaseGuard(db, own)];

  for (const resolved of snapshot.enrollments) {
    const enrollment = resolved.providerEnrollment;
    statements.push(
      db.prepare(`INSERT INTO learning_identity_links
        (connection_id,person_id,external_user_id,status,created_at,updated_at)
        VALUES (?1,?2,?3,'active',?4,?4)
        ON CONFLICT DO NOTHING`).bind(own.connectionId, resolved.personId, enrollment.externalUserId, snapshot.syncedAt),
      db.prepare(`UPDATE learning_identity_links SET status='active',updated_at=?1
        WHERE connection_id=?2 AND person_id=?3 AND external_user_id=?4`)
        .bind(snapshot.syncedAt, own.connectionId, resolved.personId, enrollment.externalUserId),
      db.prepare(`UPDATE learning_enrollments SET connection_id=0
        WHERE course_id=?1 AND (
          external_enrollment_id=?2 OR identity_link_id=(SELECT id FROM learning_identity_links
            WHERE connection_id=?3 AND person_id=?4 AND external_user_id=?5)
        ) AND NOT (
          external_enrollment_id=?2 AND identity_link_id=(SELECT id FROM learning_identity_links
            WHERE connection_id=?3 AND person_id=?4 AND external_user_id=?5)
        )`).bind(
          own.courseId, enrollment.externalEnrollmentId, own.connectionId,
          resolved.personId, enrollment.externalUserId,
        ),
      db.prepare(`INSERT INTO learning_enrollments
        (connection_id,course_id,identity_link_id,external_enrollment_id,role,state,last_synced_at,created_at,updated_at)
        SELECT ?1,?2,i.id,?3,?4,?5,?6,?6,?6 FROM learning_identity_links i
        WHERE i.connection_id=?1 AND i.person_id=?7 AND i.external_user_id=?8
        ON CONFLICT(course_id,external_enrollment_id) DO UPDATE SET
          role=excluded.role,state=excluded.state,last_synced_at=excluded.last_synced_at,
          updated_at=excluded.updated_at`).bind(
          own.connectionId, own.courseId, enrollment.externalEnrollmentId,
          enrollment.role, enrollment.state, snapshot.syncedAt,
          resolved.personId, enrollment.externalUserId,
        ),
    );
  }

  for (const activity of snapshot.activities) {
    statements.push(
      db.prepare(`UPDATE learning_activities SET kind='__learning_kind_conflict__'
        WHERE course_id=?1 AND external_activity_id=?2 AND kind<>?3`)
        .bind(own.courseId, activity.externalActivityId, activity.kind),
      db.prepare(`INSERT INTO learning_activities
        (course_id,external_activity_id,title,kind,lifecycle_state,launch_url,due_at,published_at,
         provider_updated_at,last_synced_at,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?10)
        ON CONFLICT(course_id,external_activity_id) DO UPDATE SET
          title=excluded.title,lifecycle_state=excluded.lifecycle_state,launch_url=excluded.launch_url,
          due_at=excluded.due_at,published_at=excluded.published_at,
          provider_updated_at=excluded.provider_updated_at,last_synced_at=excluded.last_synced_at,
          updated_at=excluded.updated_at`).bind(
          own.courseId, activity.externalActivityId, activity.title, activity.kind,
          activity.lifecycleState, activity.launchUrl, activity.dueAt, activity.publishedAt,
          activity.providerUpdatedAt, snapshot.syncedAt,
        ),
    );
  }

  for (const event of events) {
    statements.push(db.prepare(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at,ingested_at)
      SELECT ?1,?2,?3,?1,?4,i.person_id,i.id,e.id,?5,a.id,?6,?7,?8
      FROM learning_enrollments e
      JOIN learning_identity_links i ON i.id=e.identity_link_id AND i.connection_id=e.connection_id
      LEFT JOIN learning_activities a ON a.course_id=e.course_id AND a.external_activity_id=?9
      WHERE e.course_id=?5 AND e.connection_id=?2 AND e.external_enrollment_id=?10
        AND ((?9 IS NULL AND a.id IS NULL) OR (?9 IS NOT NULL AND a.id IS NOT NULL))
      ON CONFLICT(connection_id,source_event_id) DO NOTHING`).bind(
      event.sourceEventId, own.connectionId, own.provider, event.eventType, own.courseId,
      event.activityKind, event.occurredAt, snapshot.syncedAt, event.externalActivityId,
      event.externalEnrollmentId,
    ));
  }

  statements.push(
    db.prepare(`DELETE FROM learning_resources WHERE activity_id IN (
      SELECT id FROM learning_activities WHERE course_id=?1
    )`).bind(own.courseId),
  );
  for (const resource of snapshot.resources) {
    statements.push(db.prepare(`INSERT INTO learning_resources
      (activity_id,external_resource_id,title,kind,launch_url,youtube_video_id,mime_type,
       size_bytes,provider_updated_at,created_at,updated_at)
      SELECT a.id,?1,?2,?3,?4,?5,?6,?7,?8,?9,?9 FROM learning_activities a
      WHERE a.course_id=?10 AND a.external_activity_id=?11`).bind(
      resource.externalResourceId, resource.title, resource.kind, resource.launchUrl,
      resource.youtubeVideoId, resource.mimeType, resource.sizeBytes,
      resource.providerUpdatedAt, snapshot.syncedAt, own.courseId, resource.externalActivityId,
    ));
  }

  statements.push(db.prepare(`DELETE FROM learning_submission_snapshots WHERE course_id=?1`).bind(own.courseId));
  for (const resolved of snapshot.submissions) {
    const submission = resolved.providerSubmission;
    statements.push(db.prepare(`INSERT INTO learning_submission_snapshots
      (course_id,activity_id,activity_kind,enrollment_id,status,late,attempt_number,
       submitted_at,returned_at,provider_updated_at,synced_at)
      SELECT ?1,a.id,a.kind,e.id,?2,?3,?4,?5,?6,?7,?8
      FROM learning_activities a JOIN learning_enrollments e ON e.course_id=a.course_id
      JOIN learning_identity_links i ON i.id=e.identity_link_id
      WHERE a.course_id=?1 AND a.external_activity_id=?9
        AND a.kind IN ('assignment','quiz') AND e.external_enrollment_id=?10
        AND i.person_id=?11 AND i.external_user_id=?12`).bind(
      own.courseId, submission.status, submission.late, submission.attemptNumber,
      submission.submittedAt, submission.returnedAt, submission.providerUpdatedAt,
      snapshot.syncedAt, submission.externalActivityId, submission.externalEnrollmentId,
      resolved.personId, submission.externalUserId,
    ));
  }

  const scannedCount = snapshot.enrollments.length + snapshot.activities.length
    + snapshot.resources.length + snapshot.submissions.length;
  statements.push(
    db.prepare(`UPDATE learning_enrollments SET state='inactive',last_synced_at=?1,updated_at=?1
      WHERE course_id=?2 AND (last_synced_at IS NULL OR last_synced_at<>?1)`).bind(snapshot.syncedAt, own.courseId),
    db.prepare(`UPDATE learning_activities SET lifecycle_state='deleted',last_synced_at=?1,updated_at=?1
      WHERE course_id=?2 AND (last_synced_at IS NULL OR last_synced_at<>?1)`).bind(snapshot.syncedAt, own.courseId),
    db.prepare(`UPDATE learning_courses SET display_name=?1,launch_url=?2,lifecycle_state=?3,
      provider_updated_at=?4,last_synced_at=?5,updated_at=?5
      WHERE id=?6 AND connection_id=?7 AND provider=?8 AND external_course_id=?9`)
      .bind(
        snapshot.course.displayName, snapshot.course.launchUrl, snapshot.course.lifecycleState,
        snapshot.course.providerUpdatedAt, snapshot.syncedAt, own.courseId,
        own.connectionId, own.provider, own.externalCourseId,
      ),
    db.prepare(`UPDATE learning_sync_runs SET status='succeeded',finished_at=?1,
      scanned_count=?2,changed_count=?2,removed_count=0,
      event_count=(SELECT COUNT(*) FROM learning_activity_events
        WHERE connection_id=?3 AND ingested_at=?1),error_code=NULL
      WHERE id=?4 AND connection_id=?3 AND course_id=?5 AND status='running'
      RETURNING id AS run_id,event_count`).bind(
        snapshot.syncedAt, scannedCount, own.connectionId, own.runId, own.courseId,
      ),
    db.prepare(`UPDATE learning_provider_connections SET operation_marker=NULL,status='active',
      last_successful_sync_at=?1,last_error_code=NULL,updated_at=?1
      WHERE id=?2 AND provider=?3 AND operation_marker=?4`)
      .bind(snapshot.syncedAt, own.connectionId, own.provider, own.marker),
  );

  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length) persistenceFailure();
    const runResult = oneRow(results[results.length - 2]);
    if (!runResult || integer(runResult.run_id) !== own.runId) throw new LearningSyncConflictError();
    return Object.freeze({
      runId: own.runId, status: 'succeeded' as const, scannedCount,
      eventCount: integer(runResult.event_count, 0, LEARNING_LIMITS.maxSyncItems),
    });
  } catch (error) {
    if (error instanceof LearningSyncConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export async function failLearningSync(
  db: AppDb,
  rawLease: LearningSyncLease,
  rawInput: { readonly finishedAt: string; readonly errorCode: LearningErrorCode },
): Promise<void> {
  const own = lease(rawLease);
  const input = exact(rawInput, ['finishedAt', 'errorCode']);
  const finishedAt = timestamp(input.finishedAt);
  if (Date.parse(finishedAt) < Date.parse(own.startedAt)) invalid();
  const safeCode = errorCode(input.errorCode);
  try {
    const results = await db.batch([
      leaseGuard(db, own),
      db.prepare(`UPDATE learning_sync_runs SET status='failed',finished_at=?1,error_code=?2
        WHERE id=?3 AND connection_id=?4 AND course_id=?5 AND status='running'
        RETURNING id AS run_id`).bind(finishedAt, safeCode, own.runId, own.connectionId, own.courseId),
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=NULL,
        status=CASE WHEN ?1='authentication_required' THEN 'error' ELSE status END,
        last_error_code=?1,updated_at=?2
        WHERE id=?3 AND provider=?4 AND operation_marker=?5`)
        .bind(safeCode, finishedAt, own.connectionId, own.provider, own.marker),
    ]);
    if (!Array.isArray(results) || results.length !== 3 || !oneRow(results[1])) throw new LearningSyncConflictError();
  } catch (error) {
    if (error instanceof LearningSyncConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export interface LearningSyncRunRecord {
  readonly runId: number;
  readonly connectionId: number;
  readonly courseId: number | null;
  readonly trigger: LearningSyncTrigger;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly scannedCount: number;
  readonly changedCount: number;
  readonly removedCount: number;
  readonly eventCount: number;
  readonly errorCode: string | null;
}

export async function getLearningSyncRun(db: AppDb, rawRunId: number): Promise<LearningSyncRunRecord | null> {
  const runId = integer(rawRunId);
  try {
    const value = await db.prepare(`SELECT id AS run_id,connection_id,course_id,trigger_type,status,
      started_at,finished_at,scanned_count,changed_count,removed_count,event_count,error_code
      FROM learning_sync_runs WHERE id=?1`).bind(runId).first<Record<string, unknown>>();
    if (value === null) return null;
    const status = value.status;
    if (status !== 'running' && status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') persistenceFailure();
    if (value.finished_at !== null && typeof value.finished_at !== 'string') persistenceFailure();
    if (value.error_code !== null && typeof value.error_code !== 'string') persistenceFailure();
    return Object.freeze({
      runId: integer(value.run_id), connectionId: integer(value.connection_id),
      courseId: value.course_id === null ? null : integer(value.course_id), trigger: trigger(value.trigger_type),
      status: status as LearningSyncRunRecord['status'],
      startedAt: timestamp(value.started_at), finishedAt: value.finished_at as string | null,
      scannedCount: integer(value.scanned_count, 0, LEARNING_LIMITS.maxSyncItems),
      changedCount: integer(value.changed_count, 0, LEARNING_LIMITS.maxSyncItems),
      removedCount: integer(value.removed_count, 0, LEARNING_LIMITS.maxSyncItems),
      eventCount: integer(value.event_count, 0, LEARNING_LIMITS.maxSyncItems),
      errorCode: value.error_code as string | null,
    });
  } catch (error) {
    if (error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export interface LearningEnrollmentRecord {
  readonly enrollmentId: number;
  readonly courseId: number;
  readonly connectionId: number;
  readonly personId: number;
  readonly externalUserId: string;
  readonly externalEnrollmentId: string;
  readonly role: 'student' | 'teacher' | 'observer';
  readonly state: 'active' | 'invited' | 'completed' | 'inactive';
}

export async function listLearningEnrollmentsForPerson(
  db: AppDb,
  rawInput: { readonly courseId: number; readonly personId: number },
): Promise<readonly LearningEnrollmentRecord[]> {
  const input = exact(rawInput, ['courseId', 'personId']);
  const courseId = integer(input.courseId);
  const personId = integer(input.personId);
  try {
    const result = await db.prepare(`SELECT e.id AS enrollment_id,e.course_id,e.connection_id,
      i.person_id,i.external_user_id,e.external_enrollment_id,e.role,e.state
      FROM learning_enrollments e JOIN learning_identity_links i
        ON i.id=e.identity_link_id AND i.connection_id=e.connection_id
      JOIN learning_courses c ON c.id=e.course_id AND c.connection_id=e.connection_id
      WHERE e.course_id=?1 AND i.person_id=?2 AND i.status='active'
        AND e.state IN ('active','invited','completed')
        AND c.deleted_at IS NULL AND c.lifecycle_state<>'deleted'
      ORDER BY e.id LIMIT 100`).bind(courseId, personId).all();
    return Object.freeze(resultRows(result, 100).map((row) => {
      const role = row.role;
      const state = row.state;
      if (role !== 'student' && role !== 'teacher' && role !== 'observer') persistenceFailure();
      if (state !== 'active' && state !== 'invited' && state !== 'completed' && state !== 'inactive') persistenceFailure();
      return Object.freeze({
        enrollmentId: integer(row.enrollment_id), courseId: integer(row.course_id),
        connectionId: integer(row.connection_id), personId: integer(row.person_id),
        externalUserId: externalId(row.external_user_id),
        externalEnrollmentId: externalId(row.external_enrollment_id),
        role: role as LearningEnrollmentRecord['role'],
        state: state as LearningEnrollmentRecord['state'],
      });
    }));
  } catch (error) {
    if (error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}
