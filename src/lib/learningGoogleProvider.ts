import {
  LEARNING_LIMITS,
  LearningProviderError,
  learningSyntheticEnrollmentId,
  learningValidation,
  normalizeGoogleClassroomRosterRecord,
  type LearningActivity,
  type LearningConnectionUrlPolicy,
  type LearningCourse,
  type LearningErrorCode,
  type LearningLaunchContract,
  type LearningProviderEnrollment,
  type LearningProviderSubmission,
  type LearningResource,
} from './learningModel';
import {
  readAndNormalizeLearningPage,
  type LearningBuildLaunchRequest,
  type LearningHealthRequest,
  type LearningListCoursesRequest,
  type LearningNormalizeNotificationRequest,
  type LearningOperationContext,
  type LearningProvider,
  type LearningProviderHealth,
  type LearningProviderNotification,
  type LearningSyncActivitiesRequest,
  type LearningSyncCourseRequest,
  type LearningSyncEnrollmentsRequest,
  type LearningSyncResourcesRequest,
  type LearningSyncSubmissionsRequest,
} from './learningProvider';

const GOOGLE_CLASSROOM_API_ORIGIN = 'https://classroom.googleapis.com';
const GOOGLE_CLASSROOM_LAUNCH_ORIGIN = 'https://classroom.google.com';
const COURSE_FIELDS = 'courses(id,name,courseState,alternateLink,updateTime),nextPageToken';
const ROSTER_TEACHER_FIELDS = 'teachers(courseId,userId),nextPageToken';
const ROSTER_STUDENT_FIELDS = 'students(courseId,userId),nextPageToken';
const MATERIAL_LIST_FIELDS = 'courseWorkMaterial(id,title,state,alternateLink,creationTime,updateTime),nextPageToken';
const COURSEWORK_LIST_FIELDS = 'courseWork(id,title,state,workType,alternateLink,dueDate,dueTime,creationTime,updateTime),nextPageToken';
const RESOURCE_FIELDS = 'id,title,state,alternateLink,creationTime,updateTime,materials(youtubeVideo(id,title,alternateLink),driveFile(driveFile(id,title,alternateLink),shareMode),link(url,title),form(formUrl,responseUrl,title))';
const SUBMISSION_FIELDS = 'studentSubmissions(courseId,courseWorkId,userId,state,late,updateTime,submissionHistory(stateHistory(state,stateTimestamp))),nextPageToken';
const PHASE_PREFIXES = Object.freeze(['teachers', 'students', 'materials', 'coursework'] as const);

export interface GoogleClassroomProviderDependencies {
  readonly connectionId: number;
  readonly accessToken: string;
  readonly urlPolicy: LearningConnectionUrlPolicy;
  readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly now: () => number;
}

function googleFailure(
  code: LearningErrorCode,
  httpStatus: number | null = null,
  retryAfterSeconds: number | null = null,
): LearningProviderError {
  return new LearningProviderError({
    code, provider: 'google_classroom', httpStatus, retryAfterSeconds,
  });
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best effort only; the classified provider error remains authoritative.
  }
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get('Retry-After');
  if (raw === null || !/^(?:0|[1-9]\d{0,5})$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= LEARNING_LIMITS.maxRetryAfterSeconds ? value : null;
}

function requireSuccessfulResponse(response: unknown): Response {
  if (!(response instanceof Response)) throw googleFailure('malformed_response');
  if (response.ok) return response;
  cancelBody(response);
  if (response.status === 401) throw googleFailure('authentication_required', 401);
  if (response.status === 403) throw googleFailure('permission_denied', 403);
  if (response.status === 404) throw googleFailure('not_found', 404);
  if (response.status === 429) throw googleFailure('rate_limited', 429, retryAfter(response));
  if (response.status >= 500) throw googleFailure('provider_unavailable', response.status);
  throw googleFailure('invalid_request', response.status);
}

async function guardedStreamRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  operation: LearningOperationContext,
  now: () => number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (operation.signal.aborted) throw googleFailure('cancelled');
  const remaining = Date.parse(operation.deadlineAt) - now();
  if (remaining <= 0) throw googleFailure('timeout');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void => finish(() => reject(googleFailure('cancelled')));
    const timer = setTimeout(() => finish(() => reject(googleFailure('timeout'))), remaining);
    operation.signal.addEventListener('abort', abort, { once: true });
    reader.read().then(
      (value) => finish(() => resolve(value)),
      () => finish(() => reject(googleFailure('malformed_response'))),
    );
  });
}

async function readBoundedJson(
  response: Response,
  operation: LearningOperationContext,
  now: () => number,
): Promise<unknown> {
  if (response.body === null) throw googleFailure('malformed_response');
  const reader = response.body.getReader();
  const limit = Math.min(operation.maxRawBytes, LEARNING_LIMITS.maxPageBytes);
  const rawLength = response.headers.get('Content-Length');
  let expectedLength: number | null = null;
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength)) {
      cancelBody(response);
      throw googleFailure('malformed_response');
    }
    expectedLength = Number(rawLength);
    if (!Number.isSafeInteger(expectedLength)) {
      cancelBody(response);
      throw googleFailure('malformed_response');
    }
    if (expectedLength > limit) {
      cancelBody(response);
      throw googleFailure('response_too_large');
    }
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      part = await guardedStreamRead(reader, operation, now);
    } catch (error) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      throw error;
    }
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) throw googleFailure('malformed_response');
    length += part.value.byteLength;
    if (length > limit) {
      try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
      throw googleFailure('response_too_large');
    }
    chunks.push(part.value);
  }
  if (expectedLength !== null && expectedLength !== length) throw googleFailure('malformed_response');
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw googleFailure('malformed_response');
  }
}

function exactOptionalRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): Record<string, unknown> {
  const row = learningValidation.dataRecord(value);
  const keys = Object.keys(row);
  if (
    keys.some((key) => !allowed.includes(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(row, key))
  ) learningValidation.invalid();
  return row;
}

function optionalArray(value: unknown, maximum: number = LEARNING_LIMITS.maxPageItems): readonly unknown[] {
  return value === undefined ? Object.freeze([]) : learningValidation.dataArray(value, maximum);
}

function optionalPageToken(value: unknown): string | null {
  return value === undefined
    ? null
    : learningValidation.boundedString(value, 1, LEARNING_LIMITS.paginationTokenBytes);
}

function string(value: unknown, maximum: number = LEARNING_LIMITS.externalIdBytes): string {
  return learningValidation.boundedString(value, 1, maximum);
}

function nullableTimestamp(value: unknown): string | null {
  return value === undefined ? null : learningValidation.timestamp(value);
}

function addPageQuery(url: URL, pageSize: number, pageToken: string | null, fields: string): void {
  url.searchParams.set('pageSize', String(pageSize));
  if (pageToken !== null) url.searchParams.set('pageToken', pageToken);
  url.searchParams.set('fields', fields);
}

function phaseToken(prefix: (typeof PHASE_PREFIXES)[number], token: string): string {
  return `${prefix}:${token}`;
}

function parsePhaseToken(
  value: string | null,
  initial: (typeof PHASE_PREFIXES)[number],
  allowed: readonly (typeof PHASE_PREFIXES)[number][],
): { readonly phase: (typeof PHASE_PREFIXES)[number]; readonly token: string | null } {
  if (value === null) return Object.freeze({ phase: initial, token: null });
  const separator = value.indexOf(':');
  if (separator < 0) learningValidation.invalid();
  const phase = value.slice(0, separator);
  const rawToken = value.slice(separator + 1);
  if (!allowed.includes(phase as (typeof PHASE_PREFIXES)[number])) learningValidation.invalid();
  return Object.freeze({
    phase: phase as (typeof PHASE_PREFIXES)[number],
    token: rawToken === '' ? null : string(rawToken, LEARNING_LIMITS.paginationTokenBytes),
  });
}

function classUrl(courseId: string, activityId: string | null = null): string {
  const safeCourse = encodeURIComponent(learningValidation.externalId(courseId));
  if (activityId === null) return `${GOOGLE_CLASSROOM_LAUNCH_ORIGIN}/c/${safeCourse}`;
  const separator = activityId.indexOf(':');
  if (separator < 1) learningValidation.invalid();
  const type = activityId.slice(0, separator);
  const rawId = learningValidation.externalId(activityId.slice(separator + 1));
  const collection = type === 'coursework' ? 'a' : type === 'material' ? 'm' : learningValidation.invalid();
  return `${GOOGLE_CLASSROOM_LAUNCH_ORIGIN}/c/${safeCourse}/${collection}/${encodeURIComponent(rawId)}/details`;
}

function mapCourse(value: unknown, connectionId: number): LearningCourse {
  const row = exactOptionalRecord(
    value,
    ['id', 'name', 'courseState', 'alternateLink', 'updateTime'],
    ['id', 'name', 'courseState'],
  );
  const externalCourseId = learningValidation.externalId(row.id);
  const state = learningValidation.oneOf(row.courseState, [
    'ACTIVE', 'ARCHIVED', 'PROVISIONED', 'DECLINED', 'SUSPENDED',
  ] as const);
  return Object.freeze({
    connectionId,
    provider: 'google_classroom',
    externalCourseId,
    displayName: string(row.name, LEARNING_LIMITS.courseDisplayNameBytes),
    launchUrl: row.alternateLink === undefined
      ? classUrl(externalCourseId)
      : string(row.alternateLink, LEARNING_LIMITS.urlBytes),
    lifecycleState: state === 'ACTIVE' ? 'active' : state === 'ARCHIVED' ? 'archived' : 'deleted',
    providerUpdatedAt: nullableTimestamp(row.updateTime),
    lastSyncedAt: null,
  });
}

function mapRoster(
  value: unknown,
  connectionId: number,
  courseId: string,
  role: 'TEACHER' | 'STUDENT',
): LearningProviderEnrollment {
  const row = exactOptionalRecord(value, ['courseId', 'userId'], ['courseId', 'userId']);
  if (learningValidation.externalId(row.courseId) !== courseId) learningValidation.invalid();
  return normalizeGoogleClassroomRosterRecord({
    connectionId,
    provider: 'google_classroom',
    externalCourseId: courseId,
    externalUserId: learningValidation.externalId(row.userId),
    role,
    state: 'ACTIVE',
  });
}

function lifecycle(value: unknown): 'draft' | 'published' | 'deleted' {
  const state = learningValidation.oneOf(value, ['DRAFT', 'PUBLISHED', 'DELETED'] as const);
  return state === 'DRAFT' ? 'draft' : state === 'PUBLISHED' ? 'published' : 'deleted';
}

function dueAt(dateValue: unknown, timeValue: unknown): string | null {
  if (dateValue === undefined) {
    if (timeValue !== undefined) learningValidation.invalid();
    return null;
  }
  const date = exactOptionalRecord(dateValue, ['year', 'month', 'day'], ['year', 'month', 'day']);
  const time = timeValue === undefined
    ? Object.freeze({ hours: 0, minutes: 0, seconds: 0, nanos: 0 })
    : exactOptionalRecord(timeValue, ['hours', 'minutes', 'seconds', 'nanos']);
  const year = learningValidation.integer(date.year, 1, 9999);
  const month = learningValidation.integer(date.month, 1, 12);
  const day = learningValidation.integer(date.day, 1, 31);
  const hours = time.hours === undefined ? 0 : learningValidation.integer(time.hours, 0, 23);
  const minutes = time.minutes === undefined ? 0 : learningValidation.integer(time.minutes, 0, 59);
  const seconds = time.seconds === undefined ? 0 : learningValidation.integer(time.seconds, 0, 59);
  const nanos = time.nanos === undefined ? 0 : learningValidation.integer(time.nanos, 0, 999_999_999);
  const epoch = Date.UTC(year, month - 1, day, hours, minutes, seconds, Math.floor(nanos / 1_000_000));
  const value = new Date(epoch);
  if (
    value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day
    || value.getUTCHours() !== hours || value.getUTCMinutes() !== minutes || value.getUTCSeconds() !== seconds
  ) learningValidation.invalid();
  return value.toISOString();
}

function mapActivity(
  value: unknown,
  connectionId: number,
  courseId: string,
  source: 'material' | 'coursework',
): LearningActivity {
  const allowed = source === 'material'
    ? ['id', 'title', 'state', 'alternateLink', 'creationTime', 'updateTime']
    : ['id', 'title', 'state', 'workType', 'alternateLink', 'dueDate', 'dueTime', 'creationTime', 'updateTime'];
  const required = source === 'material' ? ['id', 'title', 'state'] : ['id', 'title', 'state', 'workType'];
  const row = exactOptionalRecord(value, allowed, required);
  const rawId = learningValidation.externalId(row.id);
  const externalActivityId = `${source}:${rawId}`;
  const kind = source === 'material'
    ? 'material'
    : learningValidation.oneOf(row.workType, [
      'ASSIGNMENT', 'SHORT_ANSWER_QUESTION', 'MULTIPLE_CHOICE_QUESTION',
    ] as const) === 'ASSIGNMENT' ? 'assignment' : 'quiz';
  return Object.freeze({
    connectionId,
    provider: 'google_classroom',
    externalCourseId: courseId,
    externalActivityId,
    title: string(row.title, LEARNING_LIMITS.titleBytes),
    kind,
    lifecycleState: lifecycle(row.state),
    launchUrl: row.alternateLink === undefined
      ? classUrl(courseId, externalActivityId)
      : string(row.alternateLink, LEARNING_LIMITS.urlBytes),
    dueAt: source === 'material' ? null : dueAt(row.dueDate, row.dueTime),
    publishedAt: nullableTimestamp(row.creationTime),
    providerUpdatedAt: nullableTimestamp(row.updateTime),
    lastSyncedAt: null,
  });
}

function stableResourceId(prefix: string, source: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(source);
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= BigInt(bytes[index]);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${prefix}_${hash.toString(16).padStart(16, '0')}`;
}

function mapResource(
  value: unknown,
  connectionId: number,
  courseId: string,
  activityId: string,
  providerUpdatedAt: string | null,
): LearningResource {
  const carrier = exactOptionalRecord(value, ['youtubeVideo', 'driveFile', 'link', 'form']);
  if (Object.keys(carrier).length !== 1) learningValidation.invalid();
  const common = { connectionId, provider: 'google_classroom' as const, externalCourseId: courseId,
    externalActivityId: activityId, providerUpdatedAt };
  if (carrier.youtubeVideo !== undefined) {
    const row = exactOptionalRecord(carrier.youtubeVideo, ['id', 'title', 'alternateLink'], ['id', 'title']);
    const youtubeVideoId = string(row.id, 11);
    return Object.freeze({
      ...common,
      externalResourceId: `youtube:${youtubeVideoId}`,
      title: string(row.title, LEARNING_LIMITS.titleBytes),
      kind: 'youtube',
      launchUrl: row.alternateLink === undefined
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeVideoId)}`
        : string(row.alternateLink, LEARNING_LIMITS.urlBytes),
      youtubeVideoId, mimeType: null, sizeBytes: null,
    });
  }
  if (carrier.driveFile !== undefined) {
    const wrapper = exactOptionalRecord(carrier.driveFile, ['driveFile', 'shareMode'], ['driveFile']);
    if (wrapper.shareMode !== undefined) {
      learningValidation.oneOf(wrapper.shareMode, ['UNKNOWN_SHARE_MODE', 'VIEW', 'EDIT', 'STUDENT_COPY'] as const);
    }
    const row = exactOptionalRecord(wrapper.driveFile, ['id', 'title', 'alternateLink'], ['id', 'title', 'alternateLink']);
    const id = learningValidation.externalId(row.id);
    return Object.freeze({
      ...common,
      externalResourceId: `drive:${id}`,
      title: string(row.title, LEARNING_LIMITS.titleBytes),
      kind: 'provider_file', launchUrl: string(row.alternateLink, LEARNING_LIMITS.urlBytes),
      youtubeVideoId: null, mimeType: null, sizeBytes: null,
    });
  }
  if (carrier.link !== undefined) {
    const row = exactOptionalRecord(carrier.link, ['url', 'title'], ['url', 'title']);
    const url = string(row.url, LEARNING_LIMITS.urlBytes);
    return Object.freeze({
      ...common,
      externalResourceId: stableResourceId('link', url),
      title: string(row.title, LEARNING_LIMITS.titleBytes),
      kind: 'link', launchUrl: url, youtubeVideoId: null, mimeType: null, sizeBytes: null,
    });
  }
  const row = exactOptionalRecord(carrier.form, ['formUrl', 'responseUrl', 'title'], ['formUrl', 'title']);
  const url = string(row.formUrl, LEARNING_LIMITS.urlBytes);
  if (row.responseUrl !== undefined) string(row.responseUrl, LEARNING_LIMITS.urlBytes);
  return Object.freeze({
    ...common,
    externalResourceId: stableResourceId('form', url),
    title: string(row.title, LEARNING_LIMITS.titleBytes),
    kind: 'link', launchUrl: url, youtubeVideoId: null, mimeType: null, sizeBytes: null,
  });
}

function mapSubmission(
  value: unknown,
  connectionId: number,
  courseId: string,
  activityId: string,
): LearningProviderSubmission {
  const row = exactOptionalRecord(value, [
    'id', 'courseId', 'courseWorkId', 'userId', 'state', 'late', 'updateTime', 'submissionHistory',
  ], ['courseId', 'courseWorkId', 'userId', 'state']);
  if (row.id !== undefined) learningValidation.externalId(row.id);
  const rawActivityId = activityId.slice('coursework:'.length);
  if (
    learningValidation.externalId(row.courseId) !== courseId
    || learningValidation.externalId(row.courseWorkId) !== rawActivityId
  ) learningValidation.invalid();
  const externalUserId = learningValidation.externalId(row.userId);
  const state = learningValidation.oneOf(row.state, [
    'NEW', 'CREATED', 'TURNED_IN', 'RETURNED', 'RECLAIMED_BY_STUDENT',
  ] as const);
  let attemptNumber = 0;
  let submittedAt: string | null = null;
  let returnedAt: string | null = null;
  const history = optionalArray(row.submissionHistory, LEARNING_LIMITS.maxSubmissionAttempts * 2);
  for (let index = 0; index < history.length; index += 1) {
    const wrapper = exactOptionalRecord(history[index], ['stateHistory'], ['stateHistory']);
    const entry = exactOptionalRecord(wrapper.stateHistory, ['state', 'stateTimestamp'], ['state', 'stateTimestamp']);
    const event = learningValidation.oneOf(entry.state, [
      'NEW', 'CREATED', 'TURNED_IN', 'RETURNED', 'RECLAIMED_BY_STUDENT',
    ] as const);
    const timestamp = learningValidation.timestamp(entry.stateTimestamp);
    if (event === 'TURNED_IN') {
      attemptNumber += 1;
      submittedAt = timestamp;
    } else if (event === 'RETURNED') returnedAt = timestamp;
  }
  const status = state === 'TURNED_IN' ? 'submitted' : state === 'RETURNED' ? 'returned' : 'not_submitted';
  if (status === 'submitted' && submittedAt === null) submittedAt = nullableTimestamp(row.updateTime);
  if (status === 'returned' && returnedAt === null) returnedAt = nullableTimestamp(row.updateTime);
  if (status === 'returned' && submittedAt === null) learningValidation.invalid();
  return Object.freeze({
    connectionId,
    provider: 'google_classroom',
    externalCourseId: courseId,
    externalActivityId: activityId,
    externalUserId,
    externalEnrollmentId: learningSyntheticEnrollmentId({
      provider: 'google_classroom', externalCourseId: courseId, externalUserId,
    }),
    status,
    late: row.late === undefined ? 0 : row.late === true ? 1 : row.late === false ? 0 : learningValidation.invalid(),
    attemptNumber,
    submittedAt: status === 'not_submitted' ? null : submittedAt,
    returnedAt: status === 'returned' ? returnedAt : null,
    providerUpdatedAt: nullableTimestamp(row.updateTime),
  });
}

function notificationResourceId(collection: string, value: unknown): string {
  if (collection === 'courses.students' || collection === 'courses.teachers') {
    const row = learningValidation.exactRecord(value, ['courseId', 'userId']);
    learningValidation.externalId(row.userId);
    return learningValidation.externalId(row.courseId);
  }
  if (collection === 'courses.courseWork') {
    const row = learningValidation.exactRecord(value, ['courseId', 'id']);
    learningValidation.externalId(row.id);
    return learningValidation.externalId(row.courseId);
  }
  if (collection === 'courses.courseWork.studentSubmissions') {
    const row = learningValidation.exactRecord(value, ['courseId', 'courseWorkId', 'id']);
    learningValidation.externalId(row.courseWorkId);
    learningValidation.externalId(row.id);
    return learningValidation.externalId(row.courseId);
  }
  return learningValidation.invalid();
}

export function createGoogleClassroomProvider(
  dependencies: GoogleClassroomProviderDependencies,
): LearningProvider {
  const connectionId = learningValidation.integer(dependencies.connectionId, 1);
  const accessToken = learningValidation.boundedString(dependencies.accessToken, 1, 8_192);
  const policy = dependencies.urlPolicy;
  if (
    policy.connectionId !== connectionId
    || policy.provider !== 'google_classroom'
    || policy.baseUrl !== null
    || typeof dependencies.fetcher !== 'function'
    || typeof dependencies.now !== 'function'
  ) learningValidation.invalid();

  const request = async (url: URL, signal: AbortSignal): Promise<Response> => {
    if (url.origin !== GOOGLE_CLASSROOM_API_ORIGIN || url.protocol !== 'https:') {
      throw googleFailure('invalid_request');
    }
    let response: Response;
    try {
      response = await dependencies.fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        signal,
      });
    } catch {
      throw googleFailure(signal.aborted ? 'cancelled' : 'provider_unavailable');
    }
    return requireSuccessfulResponse(response);
  };

  const adapter: LearningProvider = {
    provider: 'google_classroom',

    async healthCheck(input: LearningHealthRequest): Promise<LearningProviderHealth> {
      const url = new URL('/v1/courses', GOOGLE_CLASSROOM_API_ORIGIN);
      addPageQuery(url, 1, null, 'nextPageToken');
      const response = await request(url, input.operation.signal);
      cancelBody(response);
      return Object.freeze({
        connectionId, provider: 'google_classroom', healthy: 1,
        checkedAt: new Date(dependencies.now()).toISOString(), errorCode: null,
      });
    },

    async listCourses(input: LearningListCoursesRequest) {
      const url = new URL('/v1/courses', GOOGLE_CLASSROOM_API_ORIGIN);
      url.searchParams.append('courseStates', 'ACTIVE');
      url.searchParams.append('courseStates', 'ARCHIVED');
      addPageQuery(url, input.page.pageSize, input.page.pageToken, COURSE_FIELDS);
      const response = await request(url, input.operation.signal);
      return readAndNormalizeLearningPage(response, input.operation, (value) => {
        const row = exactOptionalRecord(value, ['courses', 'nextPageToken']);
        return {
          items: optionalArray(row.courses).map((item) => mapCourse(item, connectionId)),
          requestPageToken: input.page.pageToken,
          nextPageToken: optionalPageToken(row.nextPageToken),
          pageNumber: input.page.pageNumber,
        };
      }, { kind: 'courses', urlPolicy: policy }, dependencies.now);
    },

    async syncCourse(input: LearningSyncCourseRequest): Promise<LearningCourse> {
      const url = new URL(`/v1/courses/${encodeURIComponent(input.subject.externalCourseId)}`, GOOGLE_CLASSROOM_API_ORIGIN);
      url.searchParams.set('fields', 'id,name,courseState,alternateLink,updateTime');
      const response = await request(url, input.operation.signal);
      return mapCourse(await readBoundedJson(response, input.operation, dependencies.now), connectionId);
    },

    async syncEnrollments(input: LearningSyncEnrollmentsRequest) {
      const courseId = input.subject.externalCourseId;
      const phase = parsePhaseToken(input.page.pageToken, 'teachers', ['teachers', 'students']);
      const teachers = phase.phase === 'teachers';
      const collection = teachers ? 'teachers' : 'students';
      const url = new URL(
        `/v1/courses/${encodeURIComponent(courseId)}/${collection}`,
        GOOGLE_CLASSROOM_API_ORIGIN,
      );
      addPageQuery(url, input.page.pageSize, phase.token, teachers ? ROSTER_TEACHER_FIELDS : ROSTER_STUDENT_FIELDS);
      const response = await request(url, input.operation.signal);
      return readAndNormalizeLearningPage(response, input.operation, (value) => {
        const row = exactOptionalRecord(value, [collection, 'nextPageToken']);
        const next = optionalPageToken(row.nextPageToken);
        return {
          items: optionalArray(row[collection]).map((item) => mapRoster(
            item, connectionId, courseId, teachers ? 'TEACHER' : 'STUDENT',
          )),
          requestPageToken: input.page.pageToken,
          nextPageToken: teachers
            ? phaseToken(next === null ? 'students' : 'teachers', next ?? '')
            : next === null ? null : phaseToken('students', next),
          pageNumber: input.page.pageNumber,
        };
      }, { kind: 'provider_enrollments' }, dependencies.now);
    },

    async syncActivities(input: LearningSyncActivitiesRequest) {
      const courseId = input.subject.externalCourseId;
      const phase = parsePhaseToken(input.page.pageToken, 'materials', ['materials', 'coursework']);
      const materials = phase.phase === 'materials';
      const collection = materials ? 'courseWorkMaterials' : 'courseWork';
      const url = new URL(
        `/v1/courses/${encodeURIComponent(courseId)}/${collection}`,
        GOOGLE_CLASSROOM_API_ORIGIN,
      );
      addPageQuery(url, input.page.pageSize, phase.token, materials ? MATERIAL_LIST_FIELDS : COURSEWORK_LIST_FIELDS);
      const response = await request(url, input.operation.signal);
      return readAndNormalizeLearningPage(response, input.operation, (value) => {
        const responseKey = materials ? 'courseWorkMaterial' : 'courseWork';
        const row = exactOptionalRecord(value, [responseKey, 'nextPageToken']);
        const next = optionalPageToken(row.nextPageToken);
        return {
          items: optionalArray(row[responseKey]).map((item) => mapActivity(
            item, connectionId, courseId, materials ? 'material' : 'coursework',
          )),
          requestPageToken: input.page.pageToken,
          nextPageToken: materials
            ? phaseToken(next === null ? 'coursework' : 'materials', next ?? '')
            : next === null ? null : phaseToken('coursework', next),
          pageNumber: input.page.pageNumber,
        };
      }, { kind: 'activities', urlPolicy: policy }, dependencies.now);
    },

    async syncResources(input: LearningSyncResourcesRequest) {
      if (input.page.pageToken !== null || input.page.pageNumber !== 1) learningValidation.invalid();
      const courseId = input.subject.externalCourseId;
      const activityId = input.subject.externalActivityId;
      const separator = activityId.indexOf(':');
      if (separator < 1) learningValidation.invalid();
      const source = activityId.slice(0, separator);
      const rawId = learningValidation.externalId(activityId.slice(separator + 1));
      const collection = source === 'material'
        ? 'courseWorkMaterials'
        : source === 'coursework' ? 'courseWork' : learningValidation.invalid();
      const url = new URL(
        `/v1/courses/${encodeURIComponent(courseId)}/${collection}/${encodeURIComponent(rawId)}`,
        GOOGLE_CLASSROOM_API_ORIGIN,
      );
      url.searchParams.set('fields', RESOURCE_FIELDS);
      const response = await request(url, input.operation.signal);
      return readAndNormalizeLearningPage(response, input.operation, (value) => {
        const row = exactOptionalRecord(value, [
          'id', 'title', 'state', 'alternateLink', 'creationTime', 'updateTime', 'materials',
        ], ['id', 'title', 'state']);
        if (learningValidation.externalId(row.id) !== rawId) learningValidation.invalid();
        const updatedAt = nullableTimestamp(row.updateTime);
        return {
          items: optionalArray(row.materials).map((item) => mapResource(
            item, connectionId, courseId, activityId, updatedAt,
          )),
          requestPageToken: null,
          nextPageToken: null,
          pageNumber: 1,
        };
      }, { kind: 'resources', urlPolicy: policy }, dependencies.now);
    },

    async syncSubmissions(input: LearningSyncSubmissionsRequest) {
      const courseId = input.subject.externalCourseId;
      const activityId = input.subject.externalActivityId;
      if (!activityId.startsWith('coursework:')) learningValidation.invalid();
      const rawId = learningValidation.externalId(activityId.slice('coursework:'.length));
      const url = new URL(
        `/v1/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(rawId)}/studentSubmissions`,
        GOOGLE_CLASSROOM_API_ORIGIN,
      );
      addPageQuery(url, input.page.pageSize, input.page.pageToken, SUBMISSION_FIELDS);
      if (input.subject.externalEnrollmentId !== null) learningValidation.invalid();
      const response = await request(url, input.operation.signal);
      return readAndNormalizeLearningPage(response, input.operation, (value) => {
        const row = exactOptionalRecord(value, ['studentSubmissions', 'nextPageToken']);
        return {
          items: optionalArray(row.studentSubmissions).map((item) => mapSubmission(
            item, connectionId, courseId, activityId,
          )),
          requestPageToken: input.page.pageToken,
          nextPageToken: optionalPageToken(row.nextPageToken),
          pageNumber: input.page.pageNumber,
        };
      }, { kind: 'provider_submissions' }, dependencies.now);
    },

    async buildLaunchUrl(input: LearningBuildLaunchRequest) {
      const activityId = 'externalActivityId' in input.subject ? input.subject.externalActivityId : null;
      const url = classUrl(input.subject.externalCourseId, activityId);
      return Object.freeze({
        connectionId, provider: 'google_classroom',
        externalCourseId: input.subject.externalCourseId,
        externalActivityId: activityId,
        url,
      }) as unknown as LearningLaunchContract;
    },

    async normalizeNotification(input: LearningNormalizeNotificationRequest): Promise<LearningProviderNotification> {
      const row = learningValidation.exactRecord(input.payload, [
        'messageId', 'registrationId', 'collection', 'resourceId', 'receivedAt',
      ]);
      const messageId = learningValidation.externalId(row.messageId);
      learningValidation.externalId(row.registrationId);
      const collection = string(row.collection, 255);
      const externalCourseId = notificationResourceId(collection, row.resourceId);
      return Object.freeze({
        connectionId,
        provider: 'google_classroom',
        sourceEventId: messageId,
        externalCourseId,
        receivedAt: learningValidation.timestamp(row.receivedAt),
      });
    },
  };
  return Object.freeze(adapter);
}
