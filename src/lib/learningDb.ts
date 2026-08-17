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
import { canonicalLearningConnectionUrlPolicyProof } from './learningProvider';

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

export class LearningAtomicLimitError extends Error {
  readonly code = 'learning_limit_exceeded' as const;
  constructor() { super('learning_limit_exceeded'); this.name = 'LearningAtomicLimitError'; }
}

/** Conservative ceiling for one portable D1/PostgreSQL atomic reconciliation. */
export const LEARNING_MAX_ATOMIC_ENTITIES = 50;

// Cloudflare D1 Free permits at most 50 queries per Worker invocation and D1
// permits at most 100 bound parameters per query. Keep these counts beside the
// statement builders so the planner and executed paths cannot drift apart.
const LEARNING_D1_FREE_QUERY_LIMIT = 50;
const LEARNING_D1_QUERY_BIND_LIMIT = 100;
const LEARNING_SYNC_START_QUERY_COUNT = 3;
const LEARNING_SYNC_FAILURE_QUERY_COUNT = 4;
const LEARNING_IDENTITY_PREFLIGHT_CHUNK_SIZE = 40;
const LEARNING_FINALIZATION_FIXED_QUERY_COUNT = 10;
const LEARNING_FINALIZATION_ENROLLMENT_QUERY_COUNT = 5;
const LEARNING_FINALIZATION_ACTIVITY_QUERY_COUNT = 3;
const LEARNING_FINALIZATION_EVENT_QUERY_COUNT = 2;
const LEARNING_FINALIZATION_RESOURCE_QUERY_COUNT = 2;
const LEARNING_FINALIZATION_SUBMISSION_QUERY_COUNT = 2;

const persistenceFailure = (): never => { throw new LearningPersistenceError(); };
const invalid = (): never => { throw new LearningPersistenceError(); };

function assertQueryCount(actual: number, expected: number): void {
  if (actual !== expected) persistenceFailure();
}

function assertBindCount(actual: number): void {
  if (actual > LEARNING_D1_QUERY_BIND_LIMIT) throw new LearningAtomicLimitError();
}

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

async function learningUrlPolicyFingerprint(policy: LearningConnectionUrlPolicy): Promise<Uint8Array> {
  const canonical = canonicalLearningConnectionUrlPolicyProof(policy);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
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
        AND ((?3='canvas' AND c.base_url=?10)
          OR (?3='google_classroom' AND c.base_url IS NULL AND ?10 IS NULL))
      ON CONFLICT(connection_id,external_course_id) DO NOTHING
      RETURNING id AS course_id,program_id,connection_id,provider,external_course_id,
        display_name,lifecycle_state,last_synced_at`)
      .bind(
        programId, course.connectionId, course.provider, course.externalCourseId, course.displayName,
        course.launchUrl, course.lifecycleState, course.providerUpdatedAt, course.lastSyncedAt,
        policy.baseUrl,
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
    if (matching && rows.length === 1 && matching.status === 'active') return identityRow(matching);
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
  readonly leaseExpiresAt: string;
}

function lease(value: unknown): LearningSyncLease {
  const row = exact(value, [
    'runId', 'marker', 'connectionId', 'provider', 'courseId', 'externalCourseId', 'trigger', 'startedAt',
    'leaseExpiresAt',
  ]);
  const markerValue = row.marker;
  if (typeof markerValue !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(markerValue)) invalid();
  const marker = markerValue as string;
  return Object.freeze({
    runId: integer(row.runId), marker, connectionId: integer(row.connectionId),
    provider: provider(row.provider), courseId: integer(row.courseId),
    externalCourseId: externalId(row.externalCourseId), trigger: trigger(row.trigger),
    startedAt: timestamp(row.startedAt), leaseExpiresAt: timestamp(row.leaseExpiresAt),
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
    readonly urlPolicy: LearningConnectionUrlPolicy;
    readonly leaseExpiresAt: string;
  },
): Promise<LearningSyncLease> {
  const input = exact(rawInput, [
    'connectionId', 'provider', 'courseId', 'externalCourseId', 'trigger', 'startedAt', 'urlPolicy',
    'leaseExpiresAt',
  ]);
  const connectionId = integer(input.connectionId);
  const kind = provider(input.provider);
  const courseId = integer(input.courseId);
  const courseExternalId = externalId(input.externalCourseId);
  const triggerType = trigger(input.trigger);
  const startedAt = timestamp(input.startedAt);
  const leaseExpiresAt = timestamp(input.leaseExpiresAt);
  if (Date.parse(leaseExpiresAt) <= Date.parse(startedAt)) invalid();
  let policy: LearningConnectionUrlPolicy;
  try { policy = normalizeLearningConnectionUrlPolicy(input.urlPolicy); } catch { return invalid(); }
  if (policy.connectionId !== connectionId || policy.provider !== kind) invalid();
  const policyFingerprint = await learningUrlPolicyFingerprint(policy);
  const marker = crypto.randomUUID();
  const recoveryMarker = crypto.randomUUID();
  try {
    const statements = [
      db.prepare(`UPDATE learning_provider_connections
        SET operation_marker=?1,operation_expires_at=?6
        WHERE id=?2 AND provider=?3 AND status='active' AND deleted_at IS NULL
          AND ((?3='canvas' AND base_url=?8)
            OR (?3='google_classroom' AND base_url IS NULL AND ?8 IS NULL))
          AND (operation_marker IS NULL OR (
            operation_expires_at IS NOT NULL AND operation_expires_at<=?7
            AND EXISTS (SELECT 1 FROM learning_sync_runs stale
              WHERE stale.connection_id=?2 AND stale.lease_marker=operation_marker
                AND stale.status='running' AND stale.lease_expires_at<=?7)
          )) AND EXISTS (
            SELECT 1 FROM learning_courses c WHERE c.id=?4 AND c.connection_id=?2
              AND c.provider=?3 AND c.external_course_id=?5 AND c.deleted_at IS NULL
          )`).bind(
          marker, connectionId, kind, courseId, courseExternalId,
          leaseExpiresAt, startedAt, policy.baseUrl,
        ),
      db.prepare(`UPDATE learning_sync_runs SET status='cancelled',finished_at=?1,
        error_code=NULL,finalization_marker=COALESCE(finalization_marker,?2)
        WHERE connection_id=?3 AND status='running' AND lease_expires_at<=?1
          AND lease_marker<>?4 AND EXISTS (
            SELECT 1 FROM learning_provider_connections c
            WHERE c.id=?3 AND c.operation_marker=?4 AND c.operation_expires_at=?5
          )`).bind(startedAt, recoveryMarker, connectionId, marker, leaseExpiresAt),
      db.prepare(`INSERT INTO learning_sync_runs
        (connection_id,course_id,trigger_type,status,started_at,attempt_count,
         scanned_count,changed_count,removed_count,event_count,error_code,lease_marker,lease_expires_at,
         url_policy_fingerprint)
        SELECT ?1,?2,?3,'running',?4,1,0,0,0,0,NULL,?6,?7,?8
        WHERE EXISTS (SELECT 1 FROM learning_provider_connections
          WHERE id=?1 AND provider=?5 AND operation_marker=?6 AND operation_expires_at=?7)
        RETURNING id AS run_id`).bind(
          connectionId, courseId, triggerType, startedAt, kind, marker, leaseExpiresAt,
          policyFingerprint,
        ),
    ];
    assertQueryCount(statements.length, LEARNING_SYNC_START_QUERY_COUNT);
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== LEARNING_SYNC_START_QUERY_COUNT) persistenceFailure();
    const started = oneRow(results[2]);
    if (!started) throw new LearningSyncConflictError();
    return lease({
      runId: started.run_id, marker, connectionId, provider: kind, courseId,
      externalCourseId: courseExternalId, trigger: triggerType, startedAt, leaseExpiresAt,
    });
  } catch (error) {
    if (error instanceof LearningSyncConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

export async function heartbeatLearningSync(
  db: AppDb,
  rawLease: LearningSyncLease,
  rawInput: { readonly heartbeatAt: string; readonly leaseExpiresAt: string },
): Promise<LearningSyncLease> {
  const own = lease(rawLease);
  const input = exact(rawInput, ['heartbeatAt', 'leaseExpiresAt']);
  const heartbeatAt = timestamp(input.heartbeatAt);
  const leaseExpiresAt = timestamp(input.leaseExpiresAt);
  if (Date.parse(heartbeatAt) < Date.parse(own.startedAt)
    || Date.parse(heartbeatAt) >= Date.parse(own.leaseExpiresAt)
    || Date.parse(leaseExpiresAt) <= Date.parse(heartbeatAt)) invalid();
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET revision=-1
        WHERE id=?1 AND (
          provider<>?2 OR operation_marker IS NULL OR operation_marker<>?3
          OR operation_expires_at IS NULL OR operation_expires_at<=?4
          OR NOT EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?5 AND r.connection_id=?1 AND r.course_id=?6
              AND r.status='running' AND r.lease_marker=?3
              AND r.finalization_marker IS NULL AND r.lease_expires_at>?4)
        )`).bind(
          own.connectionId, own.provider, own.marker, heartbeatAt, own.runId, own.courseId,
        ),
      db.prepare(`UPDATE learning_sync_runs SET lease_expires_at=?1
        WHERE id=?2 AND connection_id=?3 AND course_id=?4 AND status='running'
          AND lease_marker=?5 AND finalization_marker IS NULL AND lease_expires_at>?6
        RETURNING id AS run_id`).bind(
          leaseExpiresAt, own.runId, own.connectionId, own.courseId, own.marker, heartbeatAt,
        ),
      db.prepare(`UPDATE learning_provider_connections SET operation_expires_at=?1,updated_at=?2
        WHERE id=?3 AND provider=?4 AND operation_marker=?5 AND operation_expires_at>?2
          AND EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?6 AND r.lease_marker=?5 AND r.lease_expires_at=?1
              AND r.status='running' AND r.finalization_marker IS NULL)
        RETURNING id AS connection_id`).bind(
          leaseExpiresAt, heartbeatAt, own.connectionId, own.provider, own.marker, own.runId,
        ),
    ]);
    if (!Array.isArray(results) || results.length !== 3
      || !oneRow(results[1]) || !oneRow(results[2])) throw new LearningSyncConflictError();
    return lease({ ...own, leaseExpiresAt });
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
  if (rawEnrollments.length + rawActivities.length + rawResources.length + rawSubmissions.length
    > LEARNING_MAX_ATOMIC_ENTITIES) throw new LearningAtomicLimitError();

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

async function hashEvent(parts: readonly string[], guard: () => void): Promise<string> {
  guard();
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  guard();
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

interface LearningSyncExecutionPlan {
  readonly identityPreflightQueries: number;
  readonly finalizationQueries: number;
  readonly maximumInvocationQueries: number;
  readonly maximumBindCount: number;
  readonly executable: boolean;
}

function planLearningSyncExecution(
  snapshot: NormalizedSnapshot,
  eventCount: number,
): LearningSyncExecutionPlan {
  const enrollmentCount = snapshot.enrollments.length;
  const activityCount = snapshot.activities.length;
  const resourceCount = snapshot.resources.length;
  const submissionCount = snapshot.submissions.length;
  const identityPreflightQueries = Math.ceil(enrollmentCount / LEARNING_IDENTITY_PREFLIGHT_CHUNK_SIZE);
  const finalizationQueries = LEARNING_FINALIZATION_FIXED_QUERY_COUNT
    + enrollmentCount * LEARNING_FINALIZATION_ENROLLMENT_QUERY_COUNT
    + activityCount * LEARNING_FINALIZATION_ACTIVITY_QUERY_COUNT
    + eventCount * LEARNING_FINALIZATION_EVENT_QUERY_COUNT
    + resourceCount * LEARNING_FINALIZATION_RESOURCE_QUERY_COUNT
    + submissionCount * LEARNING_FINALIZATION_SUBMISSION_QUERY_COUNT;
  // If the atomic finalization rejects, completeLearningCourseSync performs one
  // exact identity recheck before orchestration safely terminalizes the run.
  const maximumInvocationQueries = LEARNING_SYNC_START_QUERY_COUNT
    + identityPreflightQueries
    + finalizationQueries
    + identityPreflightQueries
    + LEARNING_SYNC_FAILURE_QUERY_COUNT;
  const identityPreflightBinds = enrollmentCount === 0
    ? 0
    : 1 + Math.min(enrollmentCount, LEARNING_IDENTITY_PREFLIGHT_CHUNK_SIZE) * 2;
  const removedCountBinds = 8 + enrollmentCount + activityCount + resourceCount * 2 + submissionCount * 2;
  const resourceKeepBinds = 3 + resourceCount * 3;
  const submissionKeepBinds = submissionCount === 0 ? 3 : 5 + submissionCount * 2;
  const maximumBindCount = Math.max(
    14, identityPreflightBinds, removedCountBinds, resourceKeepBinds, submissionKeepBinds,
  );
  return Object.freeze({
    identityPreflightQueries, finalizationQueries, maximumInvocationQueries, maximumBindCount,
    executable: maximumInvocationQueries <= LEARNING_D1_FREE_QUERY_LIMIT
      && maximumBindCount <= LEARNING_D1_QUERY_BIND_LIMIT,
  });
}

async function eventsFor(
  snapshot: NormalizedSnapshot,
  own: LearningSyncLease,
  guard: () => void,
): Promise<readonly PendingEvent[]> {
  const events: PendingEvent[] = [];
  for (const item of snapshot.enrollments) {
    const enrollment = item.providerEnrollment;
    const eventType = enrollment.state === 'active' ? 'enrolled'
      : enrollment.state === 'completed' ? 'course_completed' : null;
    if (!eventType) continue;
    const sourceEventId = await hashEvent([
      own.provider, String(own.connectionId), own.externalCourseId,
      enrollment.externalEnrollmentId, eventType,
    ], guard);
    events.push(Object.freeze({
      sourceEventId, eventType, externalEnrollmentId: enrollment.externalEnrollmentId,
      externalActivityId: null, activityKind: null, occurredAt: snapshot.syncedAt,
    }));
  }
  const activityById = new Map(snapshot.activities.map((item) => [item.externalActivityId, item]));
  for (const item of snapshot.submissions) {
    const submission = item.providerSubmission;
    const candidateActivity = activityById.get(submission.externalActivityId);
    if (!candidateActivity || (candidateActivity.kind !== 'assignment' && candidateActivity.kind !== 'quiz')) invalid();
    const activity = candidateActivity as LearningActivity & { readonly kind: 'assignment' | 'quiz' };
    const append = async (
      eventType: PendingEvent['eventType'],
      occurredAt: string,
    ): Promise<void> => {
      const sourceEventId = await hashEvent([
        own.provider, String(own.connectionId), own.externalCourseId,
        submission.externalActivityId, submission.externalEnrollmentId,
        eventType, String(submission.attemptNumber), occurredAt,
      ], guard);
      events.push(Object.freeze({
        sourceEventId, eventType, externalEnrollmentId: submission.externalEnrollmentId,
        externalActivityId: submission.externalActivityId, activityKind: activity.kind, occurredAt,
      }));
    };
    if ((submission.status === 'submitted' || submission.status === 'returned') && submission.submittedAt) {
      await append(activity.kind === 'quiz' ? 'quiz_submitted' : 'assignment_submitted', submission.submittedAt);
    }
    if (submission.status === 'returned' && submission.returnedAt) {
      await append('submission_returned', submission.returnedAt);
    }
  }
  return Object.freeze(events);
}

function activeLeaseGuard(db: AppDb, own: LearningSyncLease, at: string): AppStatement {
  // A lost, forged, or expired lease deliberately violates the revision CHECK
  // so the whole AppDb batch rolls back on SQLite/D1 and PostgreSQL.
  return db.prepare(`UPDATE learning_provider_connections SET revision=-1
    WHERE id=?1 AND (
      provider<>?2 OR status<>'active' OR deleted_at IS NOT NULL
      OR operation_marker IS NULL OR operation_marker<>?3
      OR operation_expires_at IS NULL OR operation_expires_at<=?4
      OR NOT EXISTS (SELECT 1 FROM learning_sync_runs r
        WHERE r.id=?5 AND r.connection_id=?1 AND r.course_id=?6
          AND r.status='running' AND r.lease_marker=?3
          AND r.finalization_marker IS NULL AND r.lease_expires_at>?4)
    )`).bind(own.connectionId, own.provider, own.marker, at, own.runId, own.courseId);
}

async function assertIdentityMappings(
  db: AppDb,
  own: LearningSyncLease,
  enrollments: readonly ResolvedLearningEnrollment[],
  guard: () => void = () => undefined,
): Promise<number> {
  if (enrollments.length === 0) return 0;
  let queryCount = 0;
  try {
    const chunkSize = LEARNING_IDENTITY_PREFLIGHT_CHUNK_SIZE;
    for (let start = 0; start < enrollments.length; start += chunkSize) {
      guard();
      const chunk = enrollments.slice(start, start + chunkSize);
      const userPlaceholders = chunk.map((_, index) => `?${index + 2}`).join(',');
      const personOffset = chunk.length + 2;
      const personPlaceholders = chunk.map((_, index) => `?${personOffset + index}`).join(',');
      const values = [
        own.connectionId,
        ...chunk.map((item) => item.providerEnrollment.externalUserId),
        ...chunk.map((item) => item.personId),
      ];
      assertBindCount(values.length);
      const result = await db.prepare(`SELECT person_id,external_user_id,status FROM learning_identity_links
        WHERE connection_id=?1 AND (
          external_user_id IN (${userPlaceholders}) OR person_id IN (${personPlaceholders})
        ) ORDER BY id`).bind(...values).all();
      queryCount += 1;
      const rows = resultRows(result, chunk.length * 2);
      guard();
      for (const enrollment of chunk) {
        const exactMatch = rows.find((row) => (
          row.external_user_id === enrollment.providerEnrollment.externalUserId
          && row.person_id === enrollment.personId
        ));
        if (exactMatch && exactMatch.status !== 'active') throw new LearningIdentityConflictError();
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
    return queryCount;
  } catch (error) {
    if (error instanceof LearningIdentityConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

function removedCountStatement(
  db: AppDb,
  own: LearningSyncLease,
  snapshot: NormalizedSnapshot,
  finalizationMarker: string,
): AppStatement {
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return '?';
  };
  const notIn = (column: string, ids: readonly string[]): string => ids.length === 0
    ? '1=1'
    : `${column} NOT IN (${ids.map((id) => bind(id)).join(',')})`;
  const notPairs = (
    left: string,
    right: string,
    pairs: readonly (readonly [string, string])[],
  ): string => pairs.length === 0
    ? '1=1'
    : `NOT (${pairs.map(([first, second]) => (
      `(${left}=${bind(first)} AND ${right}=${bind(second)})`
    )).join(' OR ')})`;

  const courseForEnrollments = bind(own.courseId);
  const enrollmentAbsent = notIn(
    'e.external_enrollment_id',
    snapshot.enrollments.map((item) => item.providerEnrollment.externalEnrollmentId),
  );
  const courseForActivities = bind(own.courseId);
  const activityAbsent = notIn(
    'a.external_activity_id',
    snapshot.activities.map((item) => item.externalActivityId),
  );
  const courseForResources = bind(own.courseId);
  const resourceAbsent = notPairs(
    'a.external_activity_id',
    'r.external_resource_id',
    snapshot.resources.map((item) => [item.externalActivityId, item.externalResourceId] as const),
  );
  const courseForSubmissions = bind(own.courseId);
  const submissionAbsent = notPairs(
    'a.external_activity_id',
    'e.external_enrollment_id',
    snapshot.submissions.map((item) => [
      item.providerSubmission.externalActivityId,
      item.providerSubmission.externalEnrollmentId,
    ] as const),
  );
  const runId = bind(own.runId);
  const connectionId = bind(own.connectionId);
  const courseId = bind(own.courseId);
  const marker = bind(finalizationMarker);
  assertBindCount(values.length);
  return db.prepare(`UPDATE learning_sync_runs SET removed_count=
    (SELECT COUNT(*) FROM learning_enrollments e
      WHERE e.course_id=${courseForEnrollments} AND e.state<>'inactive' AND ${enrollmentAbsent})
    +(SELECT COUNT(*) FROM learning_activities a
      WHERE a.course_id=${courseForActivities} AND a.lifecycle_state<>'deleted' AND ${activityAbsent})
    +(SELECT COUNT(*) FROM learning_resources r JOIN learning_activities a ON a.id=r.activity_id
      WHERE a.course_id=${courseForResources} AND ${resourceAbsent})
    +(SELECT COUNT(*) FROM learning_submission_snapshots s
      JOIN learning_activities a ON a.id=s.activity_id
      JOIN learning_enrollments e ON e.id=s.enrollment_id
      WHERE s.course_id=${courseForSubmissions} AND ${submissionAbsent})
    WHERE id=${runId} AND connection_id=${connectionId} AND course_id=${courseId}
      AND status='running' AND finalization_marker=${marker}`)
    .bind(...values);
}

export interface LearningSyncCompletion {
  readonly runId: number;
  readonly status: 'succeeded';
  readonly scannedCount: number;
  readonly changedCount: number;
  readonly removedCount: number;
  readonly eventCount: number;
}

export async function completeLearningCourseSync(
  db: AppDb,
  rawLease: LearningSyncLease,
  rawSnapshot: unknown,
  guard: () => void = () => undefined,
): Promise<LearningSyncCompletion> {
  guard();
  const own = lease(rawLease);
  const snapshot = normalizedSnapshot(rawSnapshot, own);
  guard();
  if (Date.parse(snapshot.syncedAt) >= Date.parse(own.leaseExpiresAt)) {
    throw new LearningSyncConflictError();
  }
  const events = await eventsFor(snapshot, own, guard);
  const executionPlan = planLearningSyncExecution(snapshot, events.length);
  if (!executionPlan.executable) throw new LearningAtomicLimitError();
  const identityPreflightQueries = await assertIdentityMappings(db, own, snapshot.enrollments, guard);
  assertQueryCount(identityPreflightQueries, executionPlan.identityPreflightQueries);
  const policyFingerprint = await learningUrlPolicyFingerprint(snapshot.urlPolicy);
  guard();
  const finalizationMarker = crypto.randomUUID();
  const statements: AppStatement[] = [
    activeLeaseGuard(db, own, snapshot.syncedAt),
    db.prepare(`UPDATE learning_sync_runs SET finalization_marker=?1
      WHERE id=?2 AND connection_id=?3 AND course_id=?4 AND status='running'
        AND lease_marker=?5 AND lease_expires_at>?6 AND finalization_marker IS NULL
        AND url_policy_fingerprint=?8
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?3 AND c.provider=?7 AND c.operation_marker=?5
            AND c.operation_expires_at>?6 AND c.status='active' AND c.deleted_at IS NULL)
      RETURNING id AS run_id`).bind(
        finalizationMarker, own.runId, own.connectionId, own.courseId,
        own.marker, snapshot.syncedAt, own.provider, policyFingerprint,
      ),
    removedCountStatement(db, own, snapshot, finalizationMarker),
  ];

  for (const resolved of snapshot.enrollments) {
    const enrollment = resolved.providerEnrollment;
    statements.push(
      db.prepare(`UPDATE learning_sync_runs SET changed_count=changed_count+1
        WHERE id=?1 AND status='running' AND finalization_marker=?9 AND NOT EXISTS (
          SELECT 1 FROM learning_enrollments e
          JOIN learning_identity_links i ON i.id=e.identity_link_id AND i.connection_id=e.connection_id
          WHERE e.course_id=?2 AND e.connection_id=?3 AND e.external_enrollment_id=?4
            AND i.person_id=?5 AND i.external_user_id=?6 AND i.status='active'
            AND e.role=?7 AND e.state=?8
        )`).bind(
          own.runId, own.courseId, own.connectionId, enrollment.externalEnrollmentId,
          resolved.personId, enrollment.externalUserId, enrollment.role, enrollment.state,
          finalizationMarker,
        ),
      db.prepare(`INSERT INTO learning_identity_links
        (connection_id,person_id,external_user_id,status,created_at,updated_at)
        SELECT ?1,?2,?3,'active',?4,?4 WHERE EXISTS (
          SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?5 AND r.status='running' AND r.finalization_marker=?6
        ) ON CONFLICT DO NOTHING`).bind(
          own.connectionId, resolved.personId, enrollment.externalUserId, snapshot.syncedAt,
          own.runId, finalizationMarker,
        ),
      db.prepare(`UPDATE learning_enrollments SET connection_id=0
        WHERE course_id=?1 AND (
          external_enrollment_id=?2 OR identity_link_id=(SELECT id FROM learning_identity_links
            WHERE connection_id=?3 AND person_id=?4 AND external_user_id=?5)
        ) AND NOT (
          external_enrollment_id=?2 AND identity_link_id=(SELECT id FROM learning_identity_links
            WHERE connection_id=?3 AND person_id=?4 AND external_user_id=?5)
        ) AND EXISTS (SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?6 AND r.status='running' AND r.finalization_marker=?7)`).bind(
          own.courseId, enrollment.externalEnrollmentId, own.connectionId,
          resolved.personId, enrollment.externalUserId, own.runId, finalizationMarker,
        ),
      db.prepare(`INSERT INTO learning_enrollments
        (connection_id,course_id,identity_link_id,external_enrollment_id,role,state,last_synced_at,created_at,updated_at)
        SELECT ?1,?2,i.id,?3,?4,?5,?6,?6,?6 FROM learning_identity_links i
        WHERE i.connection_id=?1 AND i.person_id=?7 AND i.external_user_id=?8 AND i.status='active'
          AND EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?9 AND r.status='running' AND r.finalization_marker=?10)
        ON CONFLICT(course_id,external_enrollment_id) DO UPDATE SET
          role=excluded.role,state=excluded.state,last_synced_at=excluded.last_synced_at,
          updated_at=excluded.updated_at`).bind(
          own.connectionId, own.courseId, enrollment.externalEnrollmentId,
          enrollment.role, enrollment.state, snapshot.syncedAt,
          resolved.personId, enrollment.externalUserId, own.runId, finalizationMarker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET revision=-1
        WHERE id=?1 AND operation_marker=?2
          AND EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?3 AND r.finalization_marker=?4 AND r.status='running')
          AND NOT EXISTS (
            SELECT 1 FROM learning_identity_links i
            JOIN learning_enrollments e ON e.identity_link_id=i.id AND e.connection_id=i.connection_id
            WHERE i.connection_id=?1 AND i.person_id=?5 AND i.external_user_id=?6 AND i.status='active'
              AND e.course_id=?7 AND e.external_enrollment_id=?8 AND e.role=?9 AND e.state=?10
          )`).bind(
          own.connectionId, own.marker, own.runId, finalizationMarker,
          resolved.personId, enrollment.externalUserId, own.courseId,
          enrollment.externalEnrollmentId, enrollment.role, enrollment.state,
        ),
    );
  }

  for (const activity of snapshot.activities) {
    statements.push(
      db.prepare(`UPDATE learning_sync_runs SET changed_count=changed_count+1
        WHERE id=?1 AND status='running' AND finalization_marker=?11 AND NOT EXISTS (
          SELECT 1 FROM learning_activities a WHERE a.course_id=?2 AND a.external_activity_id=?3
            AND a.title=?4 AND a.kind=?5 AND a.lifecycle_state=?6 AND a.launch_url=?7
            AND a.due_at IS NOT DISTINCT FROM ?8 AND a.published_at IS NOT DISTINCT FROM ?9
            AND a.provider_updated_at IS NOT DISTINCT FROM ?10
        )`).bind(
          own.runId, own.courseId, activity.externalActivityId, activity.title, activity.kind,
          activity.lifecycleState, activity.launchUrl, activity.dueAt, activity.publishedAt,
          activity.providerUpdatedAt, finalizationMarker,
        ),
      db.prepare(`UPDATE learning_activities SET kind='__learning_kind_conflict__'
        WHERE course_id=?1 AND external_activity_id=?2 AND kind<>?3
          AND EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?4 AND r.status='running' AND r.finalization_marker=?5)`)
        .bind(own.courseId, activity.externalActivityId, activity.kind, own.runId, finalizationMarker),
      db.prepare(`INSERT INTO learning_activities
        (course_id,external_activity_id,title,kind,lifecycle_state,launch_url,due_at,published_at,
         provider_updated_at,last_synced_at,created_at,updated_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?10
        WHERE EXISTS (SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?11 AND r.status='running' AND r.finalization_marker=?12)
        ON CONFLICT(course_id,external_activity_id) DO UPDATE SET
          title=excluded.title,lifecycle_state=excluded.lifecycle_state,launch_url=excluded.launch_url,
          due_at=excluded.due_at,published_at=excluded.published_at,
          provider_updated_at=excluded.provider_updated_at,last_synced_at=excluded.last_synced_at,
          updated_at=excluded.updated_at`).bind(
          own.courseId, activity.externalActivityId, activity.title, activity.kind,
          activity.lifecycleState, activity.launchUrl, activity.dueAt, activity.publishedAt,
          activity.providerUpdatedAt, snapshot.syncedAt, own.runId, finalizationMarker,
        ),
    );
  }

  for (const event of events) {
    statements.push(
      db.prepare(`UPDATE learning_sync_runs SET event_count=event_count+1
        WHERE id=?1 AND connection_id=?2 AND status='running' AND finalization_marker=?4 AND NOT EXISTS (
          SELECT 1 FROM learning_activity_events
          WHERE connection_id=?2 AND source_event_id=?3
        )`).bind(own.runId, own.connectionId, event.sourceEventId, finalizationMarker),
      db.prepare(`INSERT INTO learning_activity_events
      (id,connection_id,provider,source_event_id,event_type,person_id,identity_link_id,
       enrollment_id,course_id,activity_id,activity_kind,occurred_at,ingested_at)
      SELECT ?1,?2,?3,?1,?4,i.person_id,i.id,e.id,?5,a.id,?6,?7,?8
      FROM learning_enrollments e
      JOIN learning_identity_links i ON i.id=e.identity_link_id AND i.connection_id=e.connection_id
      LEFT JOIN learning_activities a ON a.course_id=e.course_id AND a.external_activity_id=?9
      WHERE e.course_id=?5 AND e.connection_id=?2 AND e.external_enrollment_id=?10
        AND ((?9 IS NULL AND a.id IS NULL) OR (?9 IS NOT NULL AND a.id IS NOT NULL))
        AND EXISTS (SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?11 AND r.status='running' AND r.finalization_marker=?12)
      ON CONFLICT(connection_id,source_event_id) DO NOTHING`).bind(
      event.sourceEventId, own.connectionId, own.provider, event.eventType, own.courseId,
      event.activityKind, event.occurredAt, snapshot.syncedAt, event.externalActivityId,
      event.externalEnrollmentId, own.runId, finalizationMarker,
      ),
    );
  }

  for (const resource of snapshot.resources) {
    statements.push(
      db.prepare(`UPDATE learning_sync_runs SET changed_count=changed_count+1
        WHERE id=?1 AND status='running' AND finalization_marker=?12 AND NOT EXISTS (
          SELECT 1 FROM learning_resources r JOIN learning_activities a ON a.id=r.activity_id
          WHERE a.course_id=?2 AND a.external_activity_id=?3 AND r.external_resource_id=?4
            AND r.title=?5 AND r.kind=?6 AND r.launch_url=?7
            AND r.youtube_video_id IS NOT DISTINCT FROM ?8
            AND r.mime_type IS NOT DISTINCT FROM ?9
            AND r.size_bytes IS NOT DISTINCT FROM ?10
            AND r.provider_updated_at IS NOT DISTINCT FROM ?11
        )`).bind(
          own.runId, own.courseId, resource.externalActivityId, resource.externalResourceId,
          resource.title, resource.kind, resource.launchUrl, resource.youtubeVideoId,
          resource.mimeType, resource.sizeBytes, resource.providerUpdatedAt, finalizationMarker,
        ),
      db.prepare(`INSERT INTO learning_resources
        (activity_id,external_resource_id,title,kind,launch_url,youtube_video_id,mime_type,
         size_bytes,provider_updated_at,created_at,updated_at)
        SELECT a.id,?1,?2,?3,?4,?5,?6,?7,?8,?9,?9 FROM learning_activities a
        WHERE a.course_id=?10 AND a.external_activity_id=?11
          AND EXISTS (SELECT 1 FROM learning_sync_runs sync_run
            WHERE sync_run.id=?12 AND sync_run.status='running'
              AND sync_run.finalization_marker=?13)
        ON CONFLICT(activity_id,external_resource_id) DO UPDATE SET
          title=excluded.title,kind=excluded.kind,launch_url=excluded.launch_url,
          youtube_video_id=excluded.youtube_video_id,mime_type=excluded.mime_type,
          size_bytes=excluded.size_bytes,provider_updated_at=excluded.provider_updated_at,
          updated_at=excluded.updated_at`).bind(
        resource.externalResourceId, resource.title, resource.kind, resource.launchUrl,
        resource.youtubeVideoId, resource.mimeType, resource.sizeBytes,
        resource.providerUpdatedAt, snapshot.syncedAt, own.courseId, resource.externalActivityId,
        own.runId, finalizationMarker,
      ),
    );
  }
  const resourceKeepSql = snapshot.resources.length === 0 ? '' : ` AND NOT (${snapshot.resources
    .map(() => `(r.activity_id=(SELECT a.id FROM learning_activities a
      WHERE a.course_id=? AND a.external_activity_id=?) AND r.external_resource_id=?)`).join(' OR ')})`;
  const resourceKeepValues = [
    own.courseId,
    ...snapshot.resources.flatMap((resource) => [
      own.courseId, resource.externalActivityId, resource.externalResourceId,
    ]),
    own.runId, finalizationMarker,
  ];
  assertBindCount(resourceKeepValues.length);
  statements.push(db.prepare(`DELETE FROM learning_resources AS r WHERE r.activity_id IN (
    SELECT a.id FROM learning_activities a WHERE a.course_id=?
  )${resourceKeepSql} AND EXISTS (SELECT 1 FROM learning_sync_runs sync_run
    WHERE sync_run.id=? AND sync_run.status='running' AND sync_run.finalization_marker=?)`).bind(
    ...resourceKeepValues,
  ));

  for (const resolved of snapshot.submissions) {
    const submission = resolved.providerSubmission;
    statements.push(
      db.prepare(`UPDATE learning_sync_runs SET changed_count=changed_count+1
        WHERE id=?1 AND status='running' AND finalization_marker=?11 AND NOT EXISTS (
          SELECT 1 FROM learning_submission_snapshots s
          JOIN learning_activities a ON a.id=s.activity_id
          JOIN learning_enrollments e ON e.id=s.enrollment_id
          WHERE s.course_id=?2 AND a.external_activity_id=?3 AND e.external_enrollment_id=?4
            AND s.status=?5 AND s.late=?6 AND s.attempt_number=?7
            AND s.submitted_at IS NOT DISTINCT FROM ?8
            AND s.returned_at IS NOT DISTINCT FROM ?9
            AND s.provider_updated_at IS NOT DISTINCT FROM ?10
        )`).bind(
          own.runId, own.courseId, submission.externalActivityId, submission.externalEnrollmentId,
          submission.status, submission.late, submission.attemptNumber, submission.submittedAt,
          submission.returnedAt, submission.providerUpdatedAt, finalizationMarker,
        ),
      db.prepare(`INSERT INTO learning_submission_snapshots
        (course_id,activity_id,activity_kind,enrollment_id,status,late,attempt_number,
         submitted_at,returned_at,provider_updated_at,synced_at)
        SELECT ?1,a.id,a.kind,e.id,?2,?3,?4,?5,?6,?7,?8
        FROM learning_activities a JOIN learning_enrollments e ON e.course_id=a.course_id
        JOIN learning_identity_links i ON i.id=e.identity_link_id
        WHERE a.course_id=?1 AND a.external_activity_id=?9
          AND a.kind IN ('assignment','quiz') AND e.external_enrollment_id=?10
          AND i.person_id=?11 AND i.external_user_id=?12 AND i.status='active'
          AND EXISTS (SELECT 1 FROM learning_sync_runs sync_run
            WHERE sync_run.id=?13 AND sync_run.status='running'
              AND sync_run.finalization_marker=?14)
        ON CONFLICT(activity_id,enrollment_id) DO UPDATE SET
          activity_kind=excluded.activity_kind,status=excluded.status,late=excluded.late,
          attempt_number=excluded.attempt_number,submitted_at=excluded.submitted_at,
          returned_at=excluded.returned_at,provider_updated_at=excluded.provider_updated_at,
          synced_at=excluded.synced_at`).bind(
        own.courseId, submission.status, submission.late, submission.attemptNumber,
        submission.submittedAt, submission.returnedAt, submission.providerUpdatedAt,
        snapshot.syncedAt, submission.externalActivityId, submission.externalEnrollmentId,
        resolved.personId, submission.externalUserId, own.runId, finalizationMarker,
      ),
    );
  }
  if (snapshot.submissions.length === 0) {
    const submissionKeepValues = [own.courseId, own.runId, finalizationMarker];
    assertBindCount(submissionKeepValues.length);
    statements.push(db.prepare(`DELETE FROM learning_submission_snapshots WHERE course_id=?
      AND EXISTS (SELECT 1 FROM learning_sync_runs r
        WHERE r.id=? AND r.status='running' AND r.finalization_marker=?)`)
      .bind(...submissionKeepValues));
  } else {
    const keepPairs = snapshot.submissions
      .map(() => '(a.external_activity_id=? AND e.external_enrollment_id=?)').join(' OR ');
    const submissionKeepValues = [
      own.courseId, own.courseId, own.courseId,
      ...snapshot.submissions.flatMap((item) => [
        item.providerSubmission.externalActivityId,
        item.providerSubmission.externalEnrollmentId,
      ]),
      own.runId, finalizationMarker,
    ];
    assertBindCount(submissionKeepValues.length);
    statements.push(db.prepare(`DELETE FROM learning_submission_snapshots
      WHERE course_id=? AND (activity_id,enrollment_id) NOT IN (
        SELECT a.id,e.id FROM learning_activities a CROSS JOIN learning_enrollments e
        WHERE a.course_id=? AND e.course_id=? AND (${keepPairs})
      ) AND EXISTS (SELECT 1 FROM learning_sync_runs sync_run
        WHERE sync_run.id=? AND sync_run.status='running'
          AND sync_run.finalization_marker=?)`).bind(...submissionKeepValues));
  }

  const scannedCount = snapshot.enrollments.length + snapshot.activities.length
    + snapshot.resources.length + snapshot.submissions.length;
  statements.push(
    db.prepare(`UPDATE learning_enrollments SET state='inactive',last_synced_at=?1,updated_at=?1
      WHERE course_id=?2 AND (last_synced_at IS NULL OR last_synced_at<>?1)
        AND EXISTS (SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?3 AND r.status='running' AND r.finalization_marker=?4)`)
      .bind(snapshot.syncedAt, own.courseId, own.runId, finalizationMarker),
    db.prepare(`UPDATE learning_activities SET lifecycle_state='deleted',last_synced_at=?1,updated_at=?1
      WHERE course_id=?2 AND (last_synced_at IS NULL OR last_synced_at<>?1)
        AND EXISTS (SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?3 AND r.status='running' AND r.finalization_marker=?4)`)
      .bind(snapshot.syncedAt, own.courseId, own.runId, finalizationMarker),
    db.prepare(`UPDATE learning_courses SET display_name=?1,launch_url=?2,lifecycle_state=?3,
      provider_updated_at=?4,last_synced_at=?5,updated_at=?5
      WHERE id=?6 AND connection_id=?7 AND provider=?8 AND external_course_id=?9
        AND EXISTS (SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?10 AND r.status='running' AND r.finalization_marker=?11)`)
      .bind(
        snapshot.course.displayName, snapshot.course.launchUrl, snapshot.course.lifecycleState,
        snapshot.course.providerUpdatedAt, snapshot.syncedAt, own.courseId,
        own.connectionId, own.provider, own.externalCourseId, own.runId, finalizationMarker,
      ),
    db.prepare(`UPDATE learning_sync_runs SET status='succeeded',finished_at=?1,
      scanned_count=?2,error_code=NULL
      WHERE id=?4 AND connection_id=?3 AND course_id=?5 AND status='running'
        AND finalization_marker=?6 AND lease_marker=?7 AND lease_expires_at>?1
      RETURNING id AS run_id,changed_count,removed_count,event_count`).bind(
        snapshot.syncedAt, scannedCount, own.connectionId, own.runId, own.courseId,
        finalizationMarker, own.marker,
      ),
    db.prepare(`UPDATE learning_provider_connections SET operation_marker=NULL,status='active',
      operation_expires_at=NULL,last_successful_sync_at=?1,last_error_code=NULL,updated_at=?1
      WHERE id=?2 AND provider=?3 AND operation_marker=?4
        AND EXISTS (SELECT 1 FROM learning_sync_runs r
          WHERE r.id=?5 AND r.status='succeeded' AND r.finalization_marker=?6)`)
      .bind(
        snapshot.syncedAt, own.connectionId, own.provider, own.marker,
        own.runId, finalizationMarker,
      ),
  );

  guard();
  assertQueryCount(statements.length, executionPlan.finalizationQueries);
  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length) persistenceFailure();
    const claimResult = oneRow(results[1]);
    const runResult = oneRow(results[results.length - 2]);
    if (!claimResult || integer(claimResult.run_id) !== own.runId
      || !runResult || integer(runResult.run_id) !== own.runId) throw new LearningSyncConflictError();
    return Object.freeze({
      runId: own.runId, status: 'succeeded' as const, scannedCount,
      changedCount: integer(runResult.changed_count, 0, LEARNING_MAX_ATOMIC_ENTITIES),
      removedCount: integer(runResult.removed_count, 0, LEARNING_LIMITS.maxSyncItems),
      eventCount: integer(runResult.event_count, 0, LEARNING_LIMITS.maxSyncItems),
    });
  } catch (error) {
    if (error instanceof LearningSyncConflictError || error instanceof LearningPersistenceError) throw error;
    try { await assertIdentityMappings(db, own, snapshot.enrollments); } catch (identityError) {
      if (identityError instanceof LearningIdentityConflictError) throw identityError;
    }
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
  if (Date.parse(finishedAt) >= Date.parse(own.leaseExpiresAt)) throw new LearningSyncConflictError();
  const safeCode = errorCode(input.errorCode);
  const finalizationMarker = crypto.randomUUID();
  try {
    const statements = [
      activeLeaseGuard(db, own, finishedAt),
      db.prepare(`UPDATE learning_sync_runs SET finalization_marker=?1
        WHERE id=?2 AND connection_id=?3 AND course_id=?4 AND status='running'
          AND lease_marker=?5 AND lease_expires_at>?6 AND finalization_marker IS NULL
          AND EXISTS (SELECT 1 FROM learning_provider_connections c
            WHERE c.id=?3 AND c.provider=?7 AND c.operation_marker=?5
              AND c.operation_expires_at>?6 AND c.status='active' AND c.deleted_at IS NULL)
        RETURNING id AS run_id`).bind(
          finalizationMarker, own.runId, own.connectionId, own.courseId,
          own.marker, finishedAt, own.provider,
        ),
      db.prepare(`UPDATE learning_sync_runs
        SET status=CASE WHEN ?1='cancelled' THEN 'cancelled' ELSE 'failed' END,
          finished_at=?2,error_code=CASE WHEN ?1='cancelled' THEN NULL ELSE ?1 END
        WHERE id=?3 AND connection_id=?4 AND course_id=?5 AND status='running'
          AND lease_marker=?6 AND finalization_marker=?7 AND lease_expires_at>?2
        RETURNING id AS run_id`).bind(
          safeCode, finishedAt, own.runId, own.connectionId, own.courseId,
          own.marker, finalizationMarker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=NULL,operation_expires_at=NULL,
        status=CASE WHEN ?1='authentication_required' THEN 'error' ELSE status END,
        last_error_code=?1,updated_at=?2
        WHERE id=?3 AND provider=?4 AND operation_marker=?5
          AND EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?6 AND r.finalization_marker=?7 AND r.status IN ('failed','cancelled'))`)
        .bind(
          safeCode, finishedAt, own.connectionId, own.provider, own.marker,
          own.runId, finalizationMarker,
        ),
    ];
    assertQueryCount(statements.length, LEARNING_SYNC_FAILURE_QUERY_COUNT);
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== LEARNING_SYNC_FAILURE_QUERY_COUNT
      || !oneRow(results[1]) || !oneRow(results[2])) throw new LearningSyncConflictError();
  } catch (error) {
    if (error instanceof LearningSyncConflictError || error instanceof LearningPersistenceError) throw error;
    throw new LearningPersistenceError();
  }
}

/**
 * Terminalize only a lease whose deadline has already elapsed. This path never
 * owns a snapshot generation; it can claim only the still-running expired run.
 */
export async function recoverExpiredLearningSync(
  db: AppDb,
  rawLease: LearningSyncLease,
  rawInput: { readonly finishedAt: string; readonly errorCode: LearningErrorCode },
): Promise<void> {
  const own = lease(rawLease);
  const input = exact(rawInput, ['finishedAt', 'errorCode']);
  const finishedAt = timestamp(input.finishedAt);
  if (Date.parse(finishedAt) < Date.parse(own.leaseExpiresAt)) invalid();
  const safeCode = errorCode(input.errorCode);
  const finalizationMarker = crypto.randomUUID();
  try {
    const statements = [
      db.prepare(`UPDATE learning_sync_runs SET finalization_marker=?1
        WHERE id=?2 AND connection_id=?3 AND course_id=?4 AND status='running'
          AND lease_marker=?5 AND lease_expires_at<=?6 AND finalization_marker IS NULL
          AND EXISTS (SELECT 1 FROM learning_provider_connections c
            WHERE c.id=?3 AND c.provider=?7 AND c.operation_marker=?5
              AND c.operation_expires_at IS NOT NULL AND c.operation_expires_at<=?6)
        RETURNING id AS run_id`).bind(
          finalizationMarker, own.runId, own.connectionId, own.courseId,
          own.marker, finishedAt, own.provider,
        ),
      db.prepare(`UPDATE learning_sync_runs
        SET status=CASE WHEN ?1='cancelled' THEN 'cancelled' ELSE 'failed' END,
          finished_at=?2,error_code=CASE WHEN ?1='cancelled' THEN NULL ELSE ?1 END
        WHERE id=?3 AND connection_id=?4 AND course_id=?5 AND status='running'
          AND lease_marker=?6 AND lease_expires_at<=?2 AND finalization_marker=?7
        RETURNING id AS run_id`).bind(
          safeCode, finishedAt, own.runId, own.connectionId, own.courseId,
          own.marker, finalizationMarker,
        ),
      db.prepare(`UPDATE learning_provider_connections
        SET operation_marker=NULL,operation_expires_at=NULL,
          status=CASE WHEN ?1='authentication_required' THEN 'error' ELSE status END,
          last_error_code=?1,updated_at=?2
        WHERE id=?3 AND provider=?4 AND operation_marker=?5
          AND operation_expires_at IS NOT NULL AND operation_expires_at<=?2
          AND EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?6 AND r.finalization_marker=?7 AND r.status IN ('failed','cancelled'))
        RETURNING id AS connection_id`).bind(
          safeCode, finishedAt, own.connectionId, own.provider, own.marker,
          own.runId, finalizationMarker,
        ),
      db.prepare(`UPDATE learning_provider_connections SET revision=-1
        WHERE id=?1 AND provider=?2 AND operation_marker=?3
          AND EXISTS (SELECT 1 FROM learning_sync_runs r
            WHERE r.id=?4 AND r.finalization_marker=?5
              AND r.status IN ('failed','cancelled'))`).bind(
          own.connectionId, own.provider, own.marker, own.runId, finalizationMarker,
        ),
    ];
    assertQueryCount(statements.length, LEARNING_SYNC_FAILURE_QUERY_COUNT);
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== LEARNING_SYNC_FAILURE_QUERY_COUNT) persistenceFailure();
    if (oneRow(results[0]) && oneRow(results[1]) && oneRow(results[2])) return;
    const observed = await db.prepare(`SELECT status FROM learning_sync_runs
      WHERE id=?1 AND connection_id=?2 AND course_id=?3 AND lease_marker=?4`)
      .bind(own.runId, own.connectionId, own.courseId, own.marker)
      .first<Record<string, unknown>>();
    if (observed && (
      observed.status === 'succeeded' || observed.status === 'failed' || observed.status === 'cancelled'
    )) {
      return;
    }
    throw new LearningSyncConflictError();
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
      JOIN learning_provider_connections pc ON pc.id=c.connection_id AND pc.provider=c.provider
      WHERE e.course_id=?1 AND i.person_id=?2 AND i.status='active'
        AND e.state='active' AND c.deleted_at IS NULL AND c.lifecycle_state='active'
        AND pc.status='active' AND pc.deleted_at IS NULL
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
