import type { AppDb, AppDbResult, AppStatement } from './appDb';
import {
  LEARNING_LIMITS,
  learningValidation,
  normalizeLearningActivity,
  normalizeLearningCourse,
  normalizeLearningResource,
  type LearningActivityKind,
  type LearningConnectionUrlPolicy,
  type LearningIntegerBoolean,
  type LearningProviderKind,
  type LearningResourceKind,
  type LearningSubmissionState,
} from './learningModel';

const MAX_LEARNER_COURSES = 100;
const MAX_LEARNER_ACTIVITIES = 1_000;
const MAX_LEARNER_RESOURCES = 1_000;
export const LEARNING_DEFAULT_FRESHNESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const GOOGLE_PROVIDER_LAUNCH_ORIGINS = Object.freeze(['https://classroom.google.com']);
const GOOGLE_PROVIDER_FILE_ORIGINS = Object.freeze(['https://drive.google.com', 'https://docs.google.com']);
const GOOGLE_EXTERNAL_LINK_ORIGINS = Object.freeze(['https://forms.gle', 'https://forms.google.com']);

export class LearningLearnerDataError extends Error {
  readonly code = 'learning_learner_data_invalid' as const;
  constructor() {
    super('learning_learner_data_invalid');
    this.name = 'LearningLearnerDataError';
  }
}

export interface LearningLearnerSubmissionView {
  readonly status: LearningSubmissionState;
  readonly late: LearningIntegerBoolean;
  readonly attemptNumber: number;
  readonly submittedAt: string | null;
  readonly returnedAt: string | null;
  readonly providerUpdatedAt: string | null;
  readonly syncedAt: string;
}

export interface LearningLearnerResourceView {
  readonly resourceId: number;
  readonly title: string;
  readonly kind: LearningResourceKind;
  readonly launchUrl: string;
  readonly youtubeVideoId: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly providerUpdatedAt: string | null;
}

export interface LearningLearnerActivityView {
  readonly activityId: number;
  readonly title: string;
  readonly kind: LearningActivityKind;
  readonly launchUrl: string;
  readonly dueAt: string | null;
  readonly publishedAt: string | null;
  readonly providerUpdatedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly submission: LearningLearnerSubmissionView | null;
  readonly resources: readonly LearningLearnerResourceView[];
}

export interface LearningLearnerCourseView {
  readonly courseId: number;
  readonly programName: string;
  readonly displayName: string;
  readonly provider: LearningProviderKind;
  readonly providerStatus: 'active';
  readonly role: 'student' | 'teacher' | 'observer';
  readonly launchUrl: string;
  readonly lastSyncedAt: string | null;
  readonly providerLastSuccessfulSyncAt: string | null;
  readonly isStale: boolean;
  readonly activities: readonly LearningLearnerActivityView[];
  readonly upcomingActivities: readonly LearningLearnerActivityView[];
  readonly recentMaterials: readonly LearningLearnerActivityView[];
}

interface LearnerReadInput {
  readonly personId: number;
  readonly nowEpochMs: number;
  readonly freshnessWindowMs?: number;
}

interface LearnerDetailReadInput extends LearnerReadInput {
  readonly courseId: number;
}

type DataRow = Record<string, unknown>;

const invalid = (): never => { throw new LearningLearnerDataError(); };

function integer(
  value: unknown,
  minimum: number = 1,
  maximum: number = LEARNING_LIMITS.databaseInteger,
): number {
  try { return learningValidation.integer(value, minimum, maximum); } catch { return invalid(); }
}

function bounded(value: unknown, maximum: number): string {
  try { return learningValidation.boundedString(value, 1, maximum); } catch { return invalid(); }
}

function timestamp(value: unknown): string | null {
  try { return learningValidation.nullableTimestamp(value); } catch { return invalid(); }
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function freshnessWindow(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 60_000 || (value as number) > 31 * 24 * 60 * 60 * 1_000) {
    invalid();
  }
  return value as number;
}

function input(value: LearnerReadInput): Required<LearnerReadInput> {
  let row: DataRow;
  try { row = learningValidation.exactRecord(value, ['personId', 'nowEpochMs', 'freshnessWindowMs']); }
  catch {
    try { row = learningValidation.exactRecord(value, ['personId', 'nowEpochMs']); }
    catch { return invalid(); }
  }
  return Object.freeze({
    personId: integer(row.personId),
    nowEpochMs: epoch(row.nowEpochMs),
    freshnessWindowMs: freshnessWindow(row.freshnessWindowMs ?? LEARNING_DEFAULT_FRESHNESS_WINDOW_MS),
  });
}

function detailInput(value: LearnerDetailReadInput): Required<LearnerDetailReadInput> {
  let row: DataRow;
  try { row = learningValidation.exactRecord(value, ['courseId', 'personId', 'nowEpochMs', 'freshnessWindowMs']); }
  catch {
    try { row = learningValidation.exactRecord(value, ['courseId', 'personId', 'nowEpochMs']); }
    catch { return invalid(); }
  }
  const common = input({
    personId: row.personId as number,
    nowEpochMs: row.nowEpochMs as number,
    ...(row.freshnessWindowMs === undefined ? {} : { freshnessWindowMs: row.freshnessWindowMs as number }),
  });
  return Object.freeze({ ...common, courseId: integer(row.courseId) });
}

function rows(result: AppDbResult<unknown> | undefined, maximum: number): readonly DataRow[] {
  if (result === undefined) return invalid();
  const resultRows = result.results;
  if (!Array.isArray(resultRows) || resultRows.length > maximum) invalid();
  return resultRows.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as DataRow;
  });
}

function policyFor(row: DataRow): LearningConnectionUrlPolicy {
  const connectionId = integer(row.connection_id);
  const provider = row.provider;
  if (provider === 'google_classroom') {
    if (row.base_url !== null) invalid();
    return Object.freeze({
      connectionId,
      provider,
      baseUrl: null,
      providerLaunchOrigins: GOOGLE_PROVIDER_LAUNCH_ORIGINS,
      providerFileOrigins: GOOGLE_PROVIDER_FILE_ORIGINS,
      externalLinkOrigins: GOOGLE_EXTERNAL_LINK_ORIGINS,
    });
  }
  if (provider !== 'canvas' || typeof row.base_url !== 'string') invalid();
  const rawBaseUrl = row.base_url as string;
  let baseUrl: string;
  try {
    const normalized = new URL(rawBaseUrl);
    if (
      normalized.protocol !== 'https:' || normalized.username !== '' || normalized.password !== ''
      || normalized.port !== '' || normalized.pathname !== '/' || normalized.search !== '' || normalized.hash !== ''
      || normalized.origin !== rawBaseUrl
    ) invalid();
    baseUrl = normalized.origin;
  } catch { return invalid(); }
  return Object.freeze({
    connectionId,
    provider: 'canvas',
    baseUrl,
    providerLaunchOrigins: Object.freeze([baseUrl]),
    providerFileOrigins: Object.freeze([baseUrl]),
    externalLinkOrigins: Object.freeze([baseUrl]),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareActivities(
  left: LearningLearnerActivityView,
  right: LearningLearnerActivityView,
  nowEpochMs: number,
): number {
  const leftDue = left.dueAt === null ? null : Date.parse(left.dueAt);
  const rightDue = right.dueAt === null ? null : Date.parse(right.dueAt);
  const bucket = (due: number | null) => due === null ? 2 : due >= nowEpochMs ? 0 : 1;
  const bucketDiff = bucket(leftDue) - bucket(rightDue);
  if (bucketDiff !== 0) return bucketDiff;
  if (leftDue !== null && rightDue !== null && leftDue !== rightDue) {
    return bucket(leftDue) === 0 ? leftDue - rightDue : rightDue - leftDue;
  }
  const leftPublished = left.publishedAt === null ? -1 : Date.parse(left.publishedAt);
  const rightPublished = right.publishedAt === null ? -1 : Date.parse(right.publishedAt);
  if (leftPublished !== rightPublished) return rightPublished - leftPublished;
  return compareText(left.title, right.title) || left.activityId - right.activityId;
}

function submissionFrom(row: DataRow): LearningLearnerSubmissionView | null {
  if (row.submission_status === null) {
    if (
      row.submission_late !== null || row.submission_attempt_number !== null
      || row.submission_submitted_at !== null || row.submission_returned_at !== null
      || row.submission_provider_updated_at !== null || row.submission_synced_at !== null
    ) invalid();
    return null;
  }
  let status: LearningSubmissionState;
  try {
    status = learningValidation.oneOf(row.submission_status, [
      'not_submitted', 'submitted', 'returned', 'excused',
    ] as const);
  } catch { return invalid(); }
  const submittedAt = timestamp(row.submission_submitted_at);
  const returnedAt = timestamp(row.submission_returned_at);
  if (status === 'not_submitted' && (submittedAt !== null || returnedAt !== null)) invalid();
  if ((status === 'submitted' || status === 'returned') && submittedAt === null) invalid();
  if (status === 'returned' && returnedAt === null) invalid();
  if (returnedAt !== null && submittedAt === null) invalid();
  return Object.freeze({
    status,
    late: integer(row.submission_late, 0, 1) as LearningIntegerBoolean,
    attemptNumber: integer(row.submission_attempt_number, 0, LEARNING_LIMITS.maxSubmissionAttempts),
    submittedAt,
    returnedAt,
    providerUpdatedAt: timestamp(row.submission_provider_updated_at),
    syncedAt: timestamp(row.submission_synced_at) ?? invalid(),
  });
}

const LIVE_SCOPE = `FROM people person
  JOIN learning_identity_links identity_link
    ON identity_link.person_id=person.id AND identity_link.status='active'
  JOIN learning_enrollments enrollment
    ON enrollment.identity_link_id=identity_link.id
    AND enrollment.connection_id=identity_link.connection_id
    AND enrollment.state='active'
  JOIN learning_courses course
    ON course.id=enrollment.course_id AND course.connection_id=enrollment.connection_id
    AND course.lifecycle_state='active' AND course.deleted_at IS NULL
  JOIN learning_programs program
    ON program.id=course.program_id AND program.status='active' AND program.deleted_at IS NULL
  JOIN learning_provider_connections connection
    ON connection.id=course.connection_id AND connection.provider=course.provider
    AND connection.status='active' AND connection.deleted_at IS NULL`;

function statements(db: AppDb, personId: number, courseId: number | null): readonly AppStatement[] {
  const courseFilter = courseId === null ? '' : ' AND course.id=?2';
  const bind = (statement: AppStatement) => courseId === null
    ? statement.bind(personId)
    : statement.bind(personId, courseId);
  return Object.freeze([
    bind(db.prepare(`SELECT course.id AS course_id,course.connection_id,course.provider,
      connection.base_url,connection.status AS provider_status,
      connection.last_successful_sync_at AS provider_last_successful_sync_at,
      course.external_course_id,course.display_name,course.launch_url,course.lifecycle_state,
      course.provider_updated_at,course.last_synced_at,program.display_name AS program_name,
      enrollment.role
      ${LIVE_SCOPE}
      WHERE person.id=?1 AND person.active=1 AND person.deleted_at IS NULL${courseFilter}
      ORDER BY course.display_name,course.id LIMIT ${MAX_LEARNER_COURSES + 1}`)),
    bind(db.prepare(`SELECT course.id AS course_id,course.connection_id,course.provider,
      connection.base_url,course.external_course_id,activity.id AS activity_id,
      activity.external_activity_id,activity.title,activity.kind,activity.lifecycle_state,
      activity.launch_url,activity.due_at,activity.published_at,activity.provider_updated_at,
      activity.last_synced_at,snapshot.status AS submission_status,snapshot.late AS submission_late,
      snapshot.attempt_number AS submission_attempt_number,
      snapshot.submitted_at AS submission_submitted_at,
      snapshot.returned_at AS submission_returned_at,
      snapshot.provider_updated_at AS submission_provider_updated_at,
      snapshot.synced_at AS submission_synced_at
      ${LIVE_SCOPE}
      JOIN learning_activities activity
        ON activity.course_id=course.id AND activity.lifecycle_state='published'
      LEFT JOIN learning_submission_snapshots snapshot
        ON snapshot.course_id=course.id AND snapshot.activity_id=activity.id
        AND snapshot.enrollment_id=enrollment.id
      WHERE person.id=?1 AND person.active=1 AND person.deleted_at IS NULL${courseFilter}
      ORDER BY course.id,activity.id LIMIT ${MAX_LEARNER_ACTIVITIES + 1}`)),
    bind(db.prepare(`SELECT course.id AS course_id,course.connection_id,course.provider,
      connection.base_url,course.external_course_id,activity.id AS activity_id,
      activity.external_activity_id,resource.id AS resource_id,resource.external_resource_id,
      resource.title,resource.kind,resource.launch_url,resource.youtube_video_id,
      resource.mime_type,resource.size_bytes,resource.provider_updated_at
      ${LIVE_SCOPE}
      JOIN learning_activities activity
        ON activity.course_id=course.id AND activity.lifecycle_state='published'
      JOIN learning_resources resource ON resource.activity_id=activity.id
      WHERE person.id=?1 AND person.active=1 AND person.deleted_at IS NULL${courseFilter}
      ORDER BY course.id,activity.id,resource.id LIMIT ${MAX_LEARNER_RESOURCES + 1}`)),
  ]);
}

async function readSnapshot(
  db: AppDb,
  personId: number,
  courseId: number | null,
): Promise<readonly [readonly DataRow[], readonly DataRow[], readonly DataRow[]]> {
  try {
    const reads = statements(db, personId, courseId) as AppStatement[];
    const results = db.snapshotBatch
      ? await db.snapshotBatch(reads)
      : await db.batch(reads);
    if (!Array.isArray(results) || results.length !== 3) invalid();
    return Object.freeze([
      rows(results[0], MAX_LEARNER_COURSES),
      rows(results[1], MAX_LEARNER_ACTIVITIES),
      rows(results[2], MAX_LEARNER_RESOURCES),
    ]);
  } catch (error) {
    if (error instanceof LearningLearnerDataError) throw error;
    throw new LearningLearnerDataError();
  }
}

function buildCourses(
  courseRows: readonly DataRow[],
  activityRows: readonly DataRow[],
  resourceRows: readonly DataRow[],
  nowEpochMs: number,
  freshnessWindowMs: number,
): readonly LearningLearnerCourseView[] {
  const resourcesByActivity = new Map<number, LearningLearnerResourceView[]>();
  const resourceIds = new Set<number>();
  for (const row of resourceRows) {
    const activityId = integer(row.activity_id);
    const resourceId = integer(row.resource_id);
    if (resourceIds.has(resourceId)) invalid();
    resourceIds.add(resourceId);
    const policy = policyFor(row);
    let normalized;
    try {
      normalized = normalizeLearningResource({
        connectionId: row.connection_id,
        provider: row.provider,
        externalCourseId: row.external_course_id,
        externalActivityId: row.external_activity_id,
        externalResourceId: row.external_resource_id,
        title: row.title,
        kind: row.kind,
        launchUrl: row.launch_url,
        youtubeVideoId: row.youtube_video_id,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        providerUpdatedAt: row.provider_updated_at,
      }, policy);
    } catch { return invalid(); }
    const resources = resourcesByActivity.get(activityId) ?? [];
    resources.push(Object.freeze({
      resourceId,
      title: normalized.title,
      kind: normalized.kind,
      launchUrl: normalized.launchUrl,
      youtubeVideoId: normalized.youtubeVideoId,
      mimeType: normalized.mimeType,
      sizeBytes: normalized.sizeBytes,
      providerUpdatedAt: normalized.providerUpdatedAt,
    }));
    resourcesByActivity.set(activityId, resources);
  }

  const activitiesByCourse = new Map<number, LearningLearnerActivityView[]>();
  const activityIds = new Set<number>();
  for (const row of activityRows) {
    const courseId = integer(row.course_id);
    const activityId = integer(row.activity_id);
    if (activityIds.has(activityId)) invalid();
    activityIds.add(activityId);
    const policy = policyFor(row);
    let normalized;
    try {
      normalized = normalizeLearningActivity({
        connectionId: row.connection_id,
        provider: row.provider,
        externalCourseId: row.external_course_id,
        externalActivityId: row.external_activity_id,
        title: row.title,
        kind: row.kind,
        lifecycleState: row.lifecycle_state,
        launchUrl: row.launch_url,
        dueAt: row.due_at,
        publishedAt: row.published_at,
        providerUpdatedAt: row.provider_updated_at,
        lastSyncedAt: row.last_synced_at,
      }, policy);
    } catch { return invalid(); }
    const activities = activitiesByCourse.get(courseId) ?? [];
    activities.push(Object.freeze({
      activityId,
      title: normalized.title,
      kind: normalized.kind,
      launchUrl: normalized.launchUrl,
      dueAt: normalized.dueAt,
      publishedAt: normalized.publishedAt,
      providerUpdatedAt: normalized.providerUpdatedAt,
      lastSyncedAt: normalized.lastSyncedAt,
      submission: submissionFrom(row),
      resources: Object.freeze(resourcesByActivity.get(activityId) ?? []),
    }));
    activitiesByCourse.set(courseId, activities);
  }
  if ([...resourcesByActivity.keys()].some((activityId) => !activityIds.has(activityId))) invalid();

  const courseIds = new Set<number>();
  const courses = courseRows.map((row): LearningLearnerCourseView => {
    const courseId = integer(row.course_id);
    if (courseIds.has(courseId) || row.provider_status !== 'active') invalid();
    courseIds.add(courseId);
    const policy = policyFor(row);
    let normalized;
    try {
      normalized = normalizeLearningCourse({
        connectionId: row.connection_id,
        provider: row.provider,
        externalCourseId: row.external_course_id,
        displayName: row.display_name,
        launchUrl: row.launch_url,
        lifecycleState: row.lifecycle_state,
        providerUpdatedAt: row.provider_updated_at,
        lastSyncedAt: row.last_synced_at,
      }, policy);
    } catch { return invalid(); }
    const role = row.role;
    if (role !== 'student' && role !== 'teacher' && role !== 'observer') invalid();
    const learnerRole = role as LearningLearnerCourseView['role'];
    const activities = Object.freeze(
      [...(activitiesByCourse.get(courseId) ?? [])]
        .sort((left, right) => compareActivities(left, right, nowEpochMs)),
    );
    const upcomingActivities = Object.freeze(activities.filter((activity) =>
      (activity.kind === 'assignment' || activity.kind === 'quiz')
      && activity.dueAt !== null && Date.parse(activity.dueAt) >= nowEpochMs));
    const recentMaterials = Object.freeze(
      activities.filter((activity) => activity.kind === 'material')
        .sort((left, right) => {
          const leftPublished = left.publishedAt === null ? -1 : Date.parse(left.publishedAt);
          const rightPublished = right.publishedAt === null ? -1 : Date.parse(right.publishedAt);
          return rightPublished - leftPublished
            || compareText(left.title, right.title)
            || left.activityId - right.activityId;
        }),
    );
    const lastSyncedAt = normalized.lastSyncedAt;
    const syncEpoch = lastSyncedAt === null ? null : Date.parse(lastSyncedAt);
    return Object.freeze({
      courseId,
      programName: bounded(row.program_name, LEARNING_LIMITS.courseDisplayNameBytes),
      displayName: normalized.displayName,
      provider: normalized.provider,
      providerStatus: 'active',
      role: learnerRole,
      launchUrl: normalized.launchUrl,
      lastSyncedAt,
      providerLastSuccessfulSyncAt: timestamp(row.provider_last_successful_sync_at),
      isStale: syncEpoch === null || nowEpochMs - syncEpoch > freshnessWindowMs,
      activities,
      upcomingActivities,
      recentMaterials,
    });
  });
  if ([...activitiesByCourse.keys()].some((courseId) => !courseIds.has(courseId))) invalid();
  return Object.freeze(courses);
}

export async function listLearningCoursesForLearner(
  db: AppDb,
  rawInput: LearnerReadInput,
): Promise<readonly LearningLearnerCourseView[]> {
  const parsed = input(rawInput);
  const [courses, activities, resources] = await readSnapshot(db, parsed.personId, null);
  return buildCourses(courses, activities, resources, parsed.nowEpochMs, parsed.freshnessWindowMs);
}

export async function getLearningCourseForLearner(
  db: AppDb,
  rawInput: LearnerDetailReadInput,
): Promise<LearningLearnerCourseView | null> {
  const parsed = detailInput(rawInput);
  const [courses, activities, resources] = await readSnapshot(db, parsed.personId, parsed.courseId);
  const built = buildCourses(courses, activities, resources, parsed.nowEpochMs, parsed.freshnessWindowMs);
  if (built.length > 1) invalid();
  return built[0] ?? null;
}
