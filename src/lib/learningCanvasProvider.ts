import {
  LEARNING_LIMITS,
  LearningProviderError,
  aggregateCanvasEnrollmentRecords,
  learningSyntheticEnrollmentId,
  learningValidation,
  normalizeCanvasBaseUrl,
  normalizeLearningCourse,
  normalizeYouTube,
  type LearningActivity,
  type CanvasEnrollmentRecord,
  type LearningConnectionUrlPolicy,
  type LearningCourse,
  type LearningLaunchContract,
  type LearningErrorCode,
  type LearningProviderEnrollment,
  type LearningProviderSubmission,
  type LearningResource,
} from './learningModel';
import {
  readAndNormalizeLearningPage,
  normalizeLearningSyncCourseRequest,
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

export const CANVAS_REQUIRED_SCOPES = Object.freeze([
  'url:GET|/api/v1/courses',
  'url:GET|/api/v1/courses/:id',
  'url:GET|/api/v1/courses/:course_id/enrollments',
  'url:GET|/api/v1/courses/:course_id/modules',
  'url:GET|/api/v1/courses/:course_id/modules/:module_id/items',
  'url:GET|/api/v1/courses/:course_id/modules/:module_id/items/:id',
  'url:GET|/api/v1/courses/:course_id/pages/:url_or_id',
  'url:GET|/api/v1/files/:id',
  'url:GET|/api/v1/courses/:course_id/assignments',
  'url:GET|/api/v1/courses/:course_id/quizzes',
  'url:GET|/api/v1/courses/:course_id/assignments/:assignment_id/submissions',
] as const);

export interface CanvasProviderDependencies {
  readonly connectionId: number;
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly urlPolicy: LearningConnectionUrlPolicy;
  readonly fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly now: () => number;
}

export interface CanvasAuthoritativeCourse {
  readonly course: LearningCourse;
  readonly rootAccountId: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const utf8 = new TextEncoder();

function failure(
  code: LearningErrorCode,
  httpStatus: number | null = null,
  retryAfterSeconds: number | null = null,
): LearningProviderError {
  return new LearningProviderError({ code, provider: 'canvas', httpStatus, retryAfterSeconds });
}

function data(value: unknown): Record<string, unknown> {
  return learningValidation.dataRecord(value);
}

function string(value: unknown, maximum: number = LEARNING_LIMITS.externalIdBytes): string {
  return learningValidation.boundedString(value, 1, maximum);
}

function externalId(value: unknown): string {
  if (typeof value === 'number') {
    return String(learningValidation.integer(value, 1, Number.MAX_SAFE_INTEGER));
  }
  return learningValidation.externalId(value);
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : learningValidation.timestamp(value);
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value !== true && value !== false) learningValidation.invalid();
  return value as boolean;
}

function array(value: unknown): readonly unknown[] {
  return value === undefined ? Object.freeze([]) : learningValidation.dataArray(value, LEARNING_LIMITS.maxPageItems);
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get('Retry-After');
  if (raw === null) return null;
  if (/^(?:0|[1-9]\d*)$/u.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) && seconds <= LEARNING_LIMITS.maxRetryAfterSeconds ? seconds : null;
  }
  return null;
}

function cancelBody(response: Response): void {
  if (response.body === null) return;
  try { void response.body.cancel().catch(() => undefined); } catch { /* best effort */ }
}

function successful(response: unknown): Response {
  if (!(response instanceof Response)) throw failure('provider_unavailable');
  if (response.status >= 200 && response.status < 300) return response;
  const status = response.status;
  cancelBody(response);
  if (status === 400) throw failure('invalid_request', status);
  if (status === 401) throw failure('authentication_required', status);
  if (status === 403) throw failure('permission_denied', status);
  if (status === 404) throw failure('not_found', status);
  if (status === 409) throw failure('conflict', status);
  if (status === 429) throw failure('rate_limited', status, retryAfter(response));
  if (status >= 500 || (status >= 300 && status < 400)) throw failure('provider_unavailable', status);
  throw failure('invalid_request', status);
}

interface BoundedCanvasResponse {
  readonly response: Response;
  readonly deadlineAt: number;
}

function requestDeadline(operation: LearningOperationContext, now: () => number): {
  readonly remaining: number;
  readonly deadlineAt: number;
} {
  const current = now();
  const deadlineAt = Math.min(Date.parse(operation.deadlineAt), current + REQUEST_TIMEOUT_MS);
  const remaining = deadlineAt - current;
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isFinite(remaining) || remaining <= 0) {
    throw failure('timeout');
  }
  return Object.freeze({ remaining, deadlineAt });
}

function boundedRequest(
  dependencies: CanvasProviderDependencies,
  baseUrl: string,
  url: URL,
  operation: LearningOperationContext,
): Promise<BoundedCanvasResponse> {
  if (
    url.origin !== baseUrl
    || url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || !url.pathname.startsWith('/api/v1/')
    || url.searchParams.has('access_token')
  ) throw failure('invalid_request');
  if (operation.signal.aborted) return Promise.reject(failure('cancelled'));
  const deadline = requestDeadline(operation, dependencies.now);
  const controller = new AbortController();
  return new Promise<BoundedCanvasResponse>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', abort);
    };
    const finishFailure = (code: 'cancelled' | 'timeout'): void => {
      controller.abort();
      if (settled) { cleanup(); return; }
      settled = true;
      cleanup();
      reject(failure(code));
    };
    const abort = (): void => finishFailure('cancelled');
    const timer = setTimeout(() => finishFailure('timeout'), deadline.remaining);
    operation.signal.addEventListener('abort', abort, { once: true });
    let pending: Promise<Response>;
    try {
      pending = Promise.resolve(dependencies.fetcher(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${dependencies.accessToken}` },
        redirect: 'manual',
        signal: controller.signal,
      }));
    } catch {
      settled = true;
      cleanup();
      reject(failure('provider_unavailable'));
      return;
    }
    pending.then((response) => {
      if (settled) {
        if (response instanceof Response) cancelBody(response);
        return;
      }
      settled = true;
      try {
        resolve(Object.freeze({ response: successful(response), deadlineAt: deadline.deadlineAt }));
      } catch (error) { cleanup(); reject(error); }
    }, () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure(operation.signal.aborted ? 'cancelled' : 'provider_unavailable'));
    });
  });
}

async function guardedRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  operation: LearningOperationContext,
  now: () => number,
  absoluteDeadlineAt?: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (operation.signal.aborted) throw failure('cancelled');
  const deadlineAt = absoluteDeadlineAt === undefined
    ? Date.parse(operation.deadlineAt)
    : Math.min(Date.parse(operation.deadlineAt), absoluteDeadlineAt);
  const remaining = deadlineAt - now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw failure('timeout');
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', abort);
    };
    const finish = (run: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      run();
    };
    const abort = (): void => finish(() => reject(failure('cancelled')));
    const timer = setTimeout(() => finish(() => reject(failure('timeout'))), remaining);
    operation.signal.addEventListener('abort', abort, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      () => finish(() => reject(failure('malformed_response'))),
    );
  });
}

async function readBoundedJson(
  response: Response,
  operation: LearningOperationContext,
  now: () => number,
  absoluteDeadlineAt?: number,
): Promise<unknown> {
  if (response.body === null) throw failure('malformed_response');
  const limit = Math.min(operation.maxRawBytes, LEARNING_LIMITS.maxPageBytes);
  const declared = response.headers.get('Content-Length');
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declared)) throw failure('malformed_response');
    const length = Number(declared);
    if (!Number.isSafeInteger(length)) throw failure('malformed_response');
    if (length > limit) { cancelBody(response); throw failure('response_too_large'); }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await guardedRead(reader, operation, now, absoluteDeadlineAt);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw failure('malformed_response');
      total += part.value.byteLength;
      if (total > limit) throw failure('response_too_large');
      chunks.push(part.value);
    }
  } catch (error) {
    try { void reader.cancel().catch(() => undefined); } catch { /* best effort */ }
    throw error;
  }
  if (declared !== null && Number(declared) !== total) throw failure('malformed_response');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw failure('malformed_response'); }
}

function endpoint(baseUrl: string, path: string): URL {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl) learningValidation.invalid();
  return url;
}

function pageUrl(
  baseUrl: string,
  path: string,
  pageSize: number,
  pageToken: string | null,
): URL {
  if (pageToken !== null) return validateOpaquePageUrl(pageToken, baseUrl, path);
  const url = endpoint(baseUrl, path);
  url.searchParams.set('per_page', String(pageSize));
  return url;
}

function validateOpaquePageUrl(value: string, baseUrl: string, exactPath: string): URL {
  if (utf8.encode(value).byteLength > LEARNING_LIMITS.paginationTokenBytes) throw failure('pagination_limit');
  let url: URL;
  try { url = new URL(value); } catch { throw failure('malformed_response'); }
  if (
    url.origin !== baseUrl
    || url.pathname !== exactPath
    || url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || url.searchParams.has('access_token')
  ) throw failure('malformed_response');
  return url;
}

function nextLink(response: Response, baseUrl: string, exactPath: string): string | null {
  const raw = response.headers.get('Link');
  if (raw === null || raw.trim() === '') return null;
  if (utf8.encode(raw).byteLength > 8_192) throw failure('malformed_response');
  const matches = [...raw.matchAll(/<([^<>]+)>\s*;\s*rel=(?:"next"|next)(?=\s*[,;]|\s*$)/giu)];
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof matches[0]?.[1] !== 'string') throw failure('malformed_response');
  const normalized = validateOpaquePageUrl(matches[0][1], baseUrl, exactPath).toString();
  if (utf8.encode(normalized).byteLength > LEARNING_LIMITS.paginationTokenBytes) throw failure('pagination_limit');
  return normalized;
}

function lifecycle(value: unknown): LearningCourse['lifecycleState'] {
  const state = string(value, 64);
  if (state === 'available' || state === 'claimed') return 'active';
  if (state === 'completed' || state === 'unpublished' || state === 'created') return 'archived';
  if (state === 'deleted') return 'deleted';
  return learningValidation.invalid();
}

function mapCourse(value: unknown, connectionId: number, baseUrl: string): LearningCourse {
  const row = data(value);
  const id = externalId(row.id);
  return Object.freeze({
    connectionId,
    provider: 'canvas',
    externalCourseId: id,
    displayName: string(row.name, LEARNING_LIMITS.courseDisplayNameBytes),
    launchUrl: `${baseUrl}/courses/${encodeURIComponent(id)}`,
    lifecycleState: lifecycle(row.workflow_state),
    providerUpdatedAt: nullableTimestamp(row.updated_at ?? row.start_at),
    lastSyncedAt: null,
  });
}

function canvasEnrollmentRecords(
  value: unknown,
  connectionId: number,
  courseId: string,
): readonly CanvasEnrollmentRecord[] {
  const rows = learningValidation.dataArray(value, LEARNING_LIMITS.maxPageItems);
  return Object.freeze(rows.map((value) => {
    const enrollment = data(value);
    externalId(enrollment.id);
    if (externalId(enrollment.course_id) !== courseId) learningValidation.invalid();
    const userId = externalId(enrollment.user_id);
    return Object.freeze({
      connectionId,
      provider: 'canvas' as const,
      externalCourseId: courseId,
      externalUserId: userId,
      type: learningValidation.oneOf(enrollment.type, [
        'StudentEnrollment', 'TeacherEnrollment', 'TaEnrollment',
        'DesignerEnrollment', 'ObserverEnrollment',
      ] as const),
      state: learningValidation.oneOf(enrollment.enrollment_state, [
        'active', 'invited', 'creation_pending', 'completed',
        'inactive', 'deleted', 'rejected',
      ] as const),
    });
  }));
}

function aggregateEnrollments(records: readonly CanvasEnrollmentRecord[]): readonly LearningProviderEnrollment[] {
  const byUser = new Map<string, CanvasEnrollmentRecord[]>();
  for (const record of records) {
    const grouped = byUser.get(record.externalUserId) ?? [];
    if (grouped.length >= LEARNING_LIMITS.maxPageItems) throw failure('pagination_limit');
    grouped.push(record);
    byUser.set(record.externalUserId, grouped);
  }
  return Object.freeze([...byUser.values()].map((records) => aggregateCanvasEnrollmentRecords(records)));
}

function enrollmentOutputToken(offset: number): string {
  return `canvas-enrollment-aggregate:v1:${learningValidation.integer(
    offset, 1, LEARNING_LIMITS.maxSyncItems,
  )}`;
}

interface CanvasEnrollmentAggregationState {
  readonly courseId: string;
  readonly expectedPageNumber: number;
  readonly expectedPageToken: string;
  readonly records: readonly CanvasEnrollmentRecord[];
  readonly output: readonly LearningProviderEnrollment[] | null;
  readonly outputOffset: number;
  readonly rawBytes: number;
}

function activityCommon(
  connectionId: number,
  courseId: string,
  externalActivityId: string,
  title: unknown,
  kind: LearningActivity['kind'],
  state: LearningActivity['lifecycleState'],
  launchUrl: unknown,
  dueAt: unknown,
  publishedAt: unknown,
  providerUpdatedAt: unknown,
): LearningActivity {
  return Object.freeze({
    connectionId,
    provider: 'canvas',
    externalCourseId: courseId,
    externalActivityId,
    title: string(title, LEARNING_LIMITS.titleBytes),
    kind,
    lifecycleState: state,
    launchUrl: string(launchUrl, LEARNING_LIMITS.urlBytes),
    dueAt: nullableTimestamp(dueAt),
    publishedAt: nullableTimestamp(publishedAt),
    providerUpdatedAt: nullableTimestamp(providerUpdatedAt),
    lastSyncedAt: null,
  });
}

function moduleActivities(
  value: unknown,
  connectionId: number,
  courseId: string,
): readonly LearningActivity[] {
  const module = data(value);
  const moduleId = externalId(module.id);
  if (module.items === undefined) return Object.freeze([]);
  const items = array(module.items);
  const result: LearningActivity[] = [];
  for (const rawItem of items) {
    const item = data(rawItem);
    const type = string(item.type, 64);
    if (!['Page', 'File', 'ExternalUrl', 'ExternalTool'].includes(type)) continue;
    const itemId = externalId(item.id);
    result.push(activityCommon(
      connectionId,
      courseId,
      `module:${moduleId}:item:${itemId}`,
      item.title,
      'material',
      optionalBoolean(item.published, true) ? 'published' : 'draft',
      item.html_url,
      null,
      null,
      null,
    ));
  }
  return Object.freeze(result);
}

function assignmentActivity(value: unknown, connectionId: number, courseId: string): LearningActivity | null {
  const row = data(value);
  if (row.is_quiz_assignment === true) return null;
  const id = externalId(row.id);
  return activityCommon(
    connectionId, courseId, `assignment:${id}`, row.name, 'assignment',
    optionalBoolean(row.published, false) ? 'published' : 'draft',
    row.html_url, row.due_at, row.unlock_at ?? row.created_at, row.updated_at,
  );
}

function quizActivity(value: unknown, connectionId: number, courseId: string): LearningActivity {
  const row = data(value);
  const quizId = externalId(row.id);
  const assignmentId = externalId(row.assignment_id);
  return activityCommon(
    connectionId, courseId, `quiz:${quizId}:assignment:${assignmentId}`, row.title, 'quiz',
    optionalBoolean(row.published, false) ? 'published' : 'draft',
    row.html_url, row.due_at, row.unlock_at ?? row.created_at, row.updated_at,
  );
}

type RegularActivityPhase = 'modules' | 'assignments' | 'quizzes';
type ActivityPhase =
  | { readonly phase: RegularActivityPhase; readonly token: string | null }
  | {
    readonly phase: 'module_items';
    readonly moduleIds: readonly string[];
    readonly itemToken: string | null;
    readonly modulesToken: string | null;
  };

function phaseToken(phase: RegularActivityPhase, token: string): string {
  const result = `${phase}|${encodeURIComponent(token)}`;
  if (utf8.encode(result).byteLength > LEARNING_LIMITS.paginationTokenBytes) throw failure('pagination_limit');
  return result;
}

function moduleItemsPhaseToken(input: {
  readonly moduleIds: readonly string[];
  readonly itemToken: string | null;
  readonly modulesToken: string | null;
}): string {
  if (input.moduleIds.length < 1 || input.moduleIds.length > LEARNING_LIMITS.maxPageItems) {
    throw failure('pagination_limit');
  }
  const payload = JSON.stringify({
    moduleIds: input.moduleIds.map(externalId),
    itemToken: input.itemToken,
    modulesToken: input.modulesToken,
  });
  return phaseToken('modules', `items:${payload}`);
}

function parsePhaseToken(value: string | null): ActivityPhase {
  if (value === null) return Object.freeze({ phase: 'modules', token: null });
  const separator = value.indexOf('|');
  if (separator < 1) throw failure('malformed_response');
  const phase = value.slice(0, separator);
  if (phase !== 'modules' && phase !== 'assignments' && phase !== 'quizzes') throw failure('malformed_response');
  let token: string;
  try { token = decodeURIComponent(value.slice(separator + 1)); } catch { throw failure('malformed_response'); }
  if (phase === 'modules' && token.startsWith('items:')) {
    let parsed: unknown;
    try { parsed = JSON.parse(token.slice('items:'.length)) as unknown; } catch { throw failure('malformed_response'); }
    const row = learningValidation.exactRecord(parsed, ['moduleIds', 'itemToken', 'modulesToken']);
    const moduleIds = learningValidation.dataArray(row.moduleIds, LEARNING_LIMITS.maxPageItems).map(externalId);
    if (moduleIds.length < 1 || new Set(moduleIds).size !== moduleIds.length) throw failure('malformed_response');
    const itemToken = row.itemToken === null ? null : string(row.itemToken, LEARNING_LIMITS.paginationTokenBytes);
    const modulesToken = row.modulesToken === null ? null : string(row.modulesToken, LEARNING_LIMITS.paginationTokenBytes);
    return Object.freeze({ phase: 'module_items', moduleIds: Object.freeze(moduleIds), itemToken, modulesToken });
  }
  return Object.freeze({ phase, token: token === '' ? null : token });
}

function nextActivityToken(phase: RegularActivityPhase, next: string | null): string | null {
  if (next !== null) return phaseToken(phase, next);
  if (phase === 'modules') return phaseToken('assignments', '');
  if (phase === 'assignments') return phaseToken('quizzes', '');
  return null;
}

function moduleItemIds(value: string): { readonly moduleId: string; readonly itemId: string } {
  const match = /^module:([^:]+):item:([^:]+)$/u.exec(value);
  if (!match) throw failure('invalid_request');
  return Object.freeze({ moduleId: externalId(match[1]), itemId: externalId(match[2]) });
}

function stableResourceId(prefix: string, value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = utf8.encode(value);
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= BigInt(bytes[index]);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `${prefix}_${hash.toString(16).padStart(16, '0')}`;
}

function linkResource(
  connectionId: number,
  courseId: string,
  activityId: string,
  title: string,
  launchUrl: string,
  providerUpdatedAt: string | null,
): LearningResource {
  try {
    const youtube = normalizeYouTube(launchUrl);
    return Object.freeze({
      connectionId, provider: 'canvas', externalCourseId: courseId, externalActivityId: activityId,
      externalResourceId: `youtube:${youtube.videoId}`, title, kind: 'youtube', launchUrl: youtube.embedUrl,
      youtubeVideoId: youtube.videoId, mimeType: null, sizeBytes: null, providerUpdatedAt,
    });
  } catch {
    return Object.freeze({
      connectionId, provider: 'canvas', externalCourseId: courseId, externalActivityId: activityId,
      externalResourceId: stableResourceId('link', launchUrl), title, kind: 'link', launchUrl,
      youtubeVideoId: null, mimeType: null, sizeBytes: null, providerUpdatedAt,
    });
  }
}

function assignmentIdFromActivity(value: string): string {
  if (value.startsWith('assignment:')) return externalId(value.slice('assignment:'.length));
  const match = /^quiz:[^:]+:assignment:([^:]+)$/u.exec(value);
  if (!match) throw failure('invalid_request');
  return externalId(match[1]);
}

function mapSubmission(
  value: unknown,
  connectionId: number,
  courseId: string,
  activityId: string,
): LearningProviderSubmission {
  const row = data(value);
  const externalUserId = externalId(row.user_id);
  const workflow = string(row.workflow_state, 64);
  let status: LearningProviderSubmission['status'];
  if (row.excused === true) status = 'excused';
  else if (workflow === 'unsubmitted') status = 'not_submitted';
  else if (workflow === 'submitted' || workflow === 'pending_review') status = 'submitted';
  else if (workflow === 'graded' || workflow === 'completed') status = 'returned';
  else return learningValidation.invalid();
  const submittedAt = status === 'not_submitted' || status === 'excused'
    ? null : nullableTimestamp(row.submitted_at);
  const returnedAt = status === 'returned' ? nullableTimestamp(row.graded_at ?? row.updated_at) : null;
  return Object.freeze({
    connectionId,
    provider: 'canvas',
    externalCourseId: courseId,
    externalActivityId: activityId,
    externalUserId,
    externalEnrollmentId: learningSyntheticEnrollmentId({
      provider: 'canvas', externalCourseId: courseId, externalUserId,
    }),
    status,
    late: row.late === true ? 1 : row.late === false || row.late === undefined ? 0 : learningValidation.invalid(),
    attemptNumber: row.attempt === null || row.attempt === undefined
      ? 0 : learningValidation.integer(row.attempt, 0, LEARNING_LIMITS.maxSubmissionAttempts),
    submittedAt,
    returnedAt,
    providerUpdatedAt: nullableTimestamp(row.updated_at),
  });
}

function activityLaunch(baseUrl: string, courseId: string, activityId: string | null): string {
  const course = `${baseUrl}/courses/${encodeURIComponent(courseId)}`;
  if (activityId === null) return course;
  if (activityId.startsWith('assignment:')) {
    return `${course}/assignments/${encodeURIComponent(assignmentIdFromActivity(activityId))}`;
  }
  const quiz = /^quiz:([^:]+):assignment:[^:]+$/u.exec(activityId);
  if (quiz) return `${course}/quizzes/${encodeURIComponent(externalId(quiz[1]))}`;
  const module = moduleItemIds(activityId);
  return `${course}/modules/items/${encodeURIComponent(module.itemId)}`;
}

function providerDependencies(dependencies: CanvasProviderDependencies): Readonly<CanvasProviderDependencies> {
  const connectionId = learningValidation.integer(dependencies.connectionId, 1, LEARNING_LIMITS.databaseInteger);
  const baseUrl = normalizeCanvasBaseUrl(dependencies.baseUrl, dependencies.urlPolicy);
  const accessToken = string(dependencies.accessToken, 8_192);
  if (
    dependencies.urlPolicy.provider !== 'canvas'
    || dependencies.urlPolicy.connectionId !== connectionId
    || dependencies.urlPolicy.baseUrl !== baseUrl
    || dependencies.urlPolicy.providerLaunchOrigins.length !== 1
    || dependencies.urlPolicy.providerLaunchOrigins[0] !== baseUrl
    || typeof dependencies.fetcher !== 'function'
    || typeof dependencies.now !== 'function'
  ) learningValidation.invalid();
  return Object.freeze({ ...dependencies, connectionId, baseUrl, accessToken });
}

export async function fetchCanvasAuthoritativeCourse(
  rawDependencies: CanvasProviderDependencies,
  rawInput: { readonly externalCourseId: string; readonly operation: LearningOperationContext },
): Promise<CanvasAuthoritativeCourse> {
  const dependencies = providerDependencies(rawDependencies);
  const request = normalizeLearningSyncCourseRequest({
    subject: {
      connectionId: dependencies.connectionId,
      provider: 'canvas',
      externalCourseId: rawInput.externalCourseId,
    },
    operation: rawInput.operation,
  }, dependencies.now());
  const courseId = request.subject.externalCourseId;
  const received = await boundedRequest(
    dependencies,
    dependencies.baseUrl,
    endpoint(dependencies.baseUrl, `/api/v1/courses/${encodeURIComponent(courseId)}`),
    request.operation,
  );
  const row = data(await readBoundedJson(
    received.response, request.operation, dependencies.now, received.deadlineAt,
  ));
  if (externalId(row.id) !== courseId) learningValidation.invalid();
  return Object.freeze({
    course: normalizeLearningCourse(
      mapCourse(row, dependencies.connectionId, dependencies.baseUrl), dependencies.urlPolicy,
    ),
    rootAccountId: externalId(row.root_account_id),
  });
}

export function createCanvasProvider(dependencies: CanvasProviderDependencies): LearningProvider {
  const safeDependencies = providerDependencies(dependencies);
  const { connectionId, baseUrl } = safeDependencies;
  const request = (url: URL, operation: LearningOperationContext) => boundedRequest(
    safeDependencies, baseUrl, url, operation,
  );
  let enrollmentAggregation: CanvasEnrollmentAggregationState | null = null;

  const adapter: LearningProvider = {
    provider: 'canvas',

    async healthCheck(input: LearningHealthRequest): Promise<LearningProviderHealth> {
      const url = endpoint(baseUrl, '/api/v1/courses');
      url.searchParams.set('per_page', '1');
      const received = await request(url, input.operation);
      cancelBody(received.response);
      return Object.freeze({
        connectionId, provider: 'canvas', healthy: 1,
        checkedAt: new Date(dependencies.now()).toISOString(), errorCode: null,
      });
    },

    async listCourses(input: LearningListCoursesRequest) {
      const path = '/api/v1/courses';
      const url = pageUrl(baseUrl, path, input.page.pageSize, input.page.pageToken);
      const received = await request(url, input.operation);
      const next = nextLink(received.response, baseUrl, path);
      return readAndNormalizeLearningPage(received.response, input.operation, (value) => ({
        items: learningValidation.dataArray(value, LEARNING_LIMITS.maxPageItems)
          .map((item) => mapCourse(item, connectionId, baseUrl)),
        requestPageToken: input.page.pageToken,
        nextPageToken: next,
        pageNumber: input.page.pageNumber,
      }), { kind: 'courses', urlPolicy: dependencies.urlPolicy }, dependencies.now, received.deadlineAt);
    },

    async syncCourse(input: LearningSyncCourseRequest): Promise<LearningCourse> {
      const id = encodeURIComponent(input.subject.externalCourseId);
      const received = await request(endpoint(baseUrl, `/api/v1/courses/${id}`), input.operation);
      const value = await readBoundedJson(
        received.response, input.operation, dependencies.now, received.deadlineAt,
      );
      return mapCourse(value, connectionId, baseUrl);
    },

    async syncEnrollments(input: LearningSyncEnrollmentsRequest) {
      const courseId = input.subject.externalCourseId;
      const path = `/api/v1/courses/${encodeURIComponent(courseId)}/enrollments`;
      if (input.page.pageToken === null) {
        if (input.page.pageNumber !== 1 || enrollmentAggregation !== null) learningValidation.invalid();
        enrollmentAggregation = Object.freeze({
          courseId, expectedPageNumber: 1, expectedPageToken: '', records: Object.freeze([]),
          output: null, outputOffset: 0, rawBytes: 0,
        });
      }
      const currentAggregation = enrollmentAggregation;
      if (currentAggregation === null) return learningValidation.invalid();
      const state: CanvasEnrollmentAggregationState = currentAggregation;
      if (
        state.courseId !== courseId
        || state.expectedPageNumber !== input.page.pageNumber
        || (input.page.pageToken ?? '') !== state.expectedPageToken
      ) learningValidation.invalid();
      try {
        if (state.output !== null) {
          const end = Math.min(state.outputOffset + input.page.pageSize, state.output.length);
          const items = Object.freeze(state.output.slice(state.outputOffset, end));
          const next = end < state.output.length ? enrollmentOutputToken(end) : null;
          if (next !== null && input.page.pageNumber >= input.operation.maxPages) {
            throw failure('pagination_limit');
          }
          const response = new Response(JSON.stringify(items), {
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
          });
          const page = await readAndNormalizeLearningPage(response, input.operation, (value) => ({
            items: learningValidation.dataArray(value, LEARNING_LIMITS.maxPageItems),
            requestPageToken: input.page.pageToken,
            nextPageToken: next,
            pageNumber: input.page.pageNumber,
          }), { kind: 'provider_enrollments' }, dependencies.now);
          const rawBytes = state.rawBytes + page.responseBytes;
          if (rawBytes > input.operation.maxRawBytes) throw failure('pagination_limit');
          enrollmentAggregation = next === null ? null : Object.freeze({
            ...state,
            expectedPageNumber: input.page.pageNumber + 1,
            expectedPageToken: next,
            outputOffset: end,
            rawBytes,
          });
          return page;
        }

        const url = pageUrl(baseUrl, path, input.page.pageSize, input.page.pageToken);
        if (input.page.pageToken === null) {
          for (const enrollmentState of ['active', 'invited', 'creation_pending', 'completed', 'inactive']) {
            url.searchParams.append('state[]', enrollmentState);
          }
        }
        const received = await request(url, input.operation);
        const remoteNext = nextLink(received.response, baseUrl, path);
        let parsed: readonly CanvasEnrollmentRecord[] = Object.freeze([]);
        let aggregated: readonly LearningProviderEnrollment[] | null = null;
        let combined: readonly CanvasEnrollmentRecord[] = state.records;
        let limitExceeded = false;
        const page = await readAndNormalizeLearningPage(received.response, input.operation, (value) => {
          parsed = canvasEnrollmentRecords(value, connectionId, courseId);
          combined = Object.freeze([...state.records, ...parsed]);
          if (combined.length > input.operation.maxItems) limitExceeded = true;
          if (remoteNext !== null) {
            if (input.page.pageNumber >= input.operation.maxPages) limitExceeded = true;
            return {
              items: [], requestPageToken: input.page.pageToken,
              nextPageToken: remoteNext, pageNumber: input.page.pageNumber,
            };
          }
          if (!limitExceeded) {
            try { aggregated = aggregateEnrollments(combined); }
            catch { limitExceeded = true; }
          }
          if (limitExceeded || aggregated === null) {
            return {
              items: [], requestPageToken: input.page.pageToken,
              nextPageToken: null, pageNumber: input.page.pageNumber,
            };
          }
          const outputPages = Math.max(1, Math.ceil(aggregated.length / input.page.pageSize));
          if (input.page.pageNumber + outputPages - 1 > input.operation.maxPages) {
            limitExceeded = true;
            return {
              items: [], requestPageToken: input.page.pageToken,
              nextPageToken: null, pageNumber: input.page.pageNumber,
            };
          }
          const end = Math.min(input.page.pageSize, aggregated.length);
          return {
            items: aggregated.slice(0, end),
            requestPageToken: input.page.pageToken,
            nextPageToken: end < aggregated.length ? enrollmentOutputToken(end) : null,
            pageNumber: input.page.pageNumber,
          };
        }, { kind: 'provider_enrollments' }, dependencies.now, received.deadlineAt);
        if (limitExceeded) throw failure('pagination_limit');
        const rawBytes = state.rawBytes + page.responseBytes;
        if (rawBytes > input.operation.maxRawBytes) throw failure('pagination_limit');
        if (remoteNext !== null) {
          enrollmentAggregation = Object.freeze({
            ...state,
            expectedPageNumber: input.page.pageNumber + 1,
            expectedPageToken: remoteNext,
            records: combined,
            rawBytes,
          });
        } else if (page.nextPageToken !== null && aggregated !== null) {
          const output = aggregated as readonly LearningProviderEnrollment[];
          enrollmentAggregation = Object.freeze({
            courseId,
            expectedPageNumber: input.page.pageNumber + 1,
            expectedPageToken: page.nextPageToken,
            records: Object.freeze([]),
            output,
            outputOffset: Math.min(input.page.pageSize, output.length),
            rawBytes,
          });
        } else {
          enrollmentAggregation = null;
        }
        return page;
      } catch (error) {
        enrollmentAggregation = null;
        throw error;
      }
    },

    async syncActivities(input: LearningSyncActivitiesRequest) {
      const courseId = input.subject.externalCourseId;
      const phase = parsePhaseToken(input.page.pageToken);
      if (phase.phase === 'module_items') {
        const moduleId = phase.moduleIds[0];
        const path = `/api/v1/courses/${encodeURIComponent(courseId)}/modules/${encodeURIComponent(moduleId)}/items`;
        const url = pageUrl(baseUrl, path, input.page.pageSize, phase.itemToken);
        const received = await request(url, input.operation);
        const next = nextLink(received.response, baseUrl, path);
        return readAndNormalizeLearningPage(received.response, input.operation, (value) => {
          let nextPageToken: string | null;
          if (next !== null) {
            nextPageToken = moduleItemsPhaseToken({ ...phase, itemToken: next });
          } else if (phase.moduleIds.length > 1) {
            nextPageToken = moduleItemsPhaseToken({
              moduleIds: phase.moduleIds.slice(1), itemToken: null, modulesToken: phase.modulesToken,
            });
          } else {
            nextPageToken = phase.modulesToken === null
              ? phaseToken('assignments', '')
              : phaseToken('modules', phase.modulesToken);
          }
          return {
            items: learningValidation.dataArray(value, LEARNING_LIMITS.maxPageItems).flatMap((item) => moduleActivities({
              id: moduleId, items: [item],
            }, connectionId, courseId)),
            requestPageToken: input.page.pageToken,
            nextPageToken,
            pageNumber: input.page.pageNumber,
          };
        }, { kind: 'activities', urlPolicy: dependencies.urlPolicy }, dependencies.now, received.deadlineAt);
      }
      const path = `/api/v1/courses/${encodeURIComponent(courseId)}/${phase.phase}`;
      const url = pageUrl(baseUrl, path, input.page.pageSize, phase.token);
      if (phase.token === null && phase.phase === 'modules') url.searchParams.append('include[]', 'items');
      const received = await request(url, input.operation);
      const next = nextLink(received.response, baseUrl, path);
      return readAndNormalizeLearningPage(received.response, input.operation, (value) => {
        const rows = learningValidation.dataArray(value, LEARNING_LIMITS.maxPageItems);
        const missingModuleIds = phase.phase === 'modules'
          ? rows.filter((item) => data(item).items === undefined).map((item) => externalId(data(item).id))
          : [];
        const items = phase.phase === 'modules'
          ? rows.flatMap((item) => moduleActivities(item, connectionId, courseId))
          : phase.phase === 'assignments'
            ? rows.map((item) => assignmentActivity(item, connectionId, courseId)).filter(
              (item): item is LearningActivity => item !== null,
            )
            : rows.map((item) => quizActivity(item, connectionId, courseId));
        return {
          items,
          requestPageToken: input.page.pageToken,
          nextPageToken: missingModuleIds.length > 0
            ? moduleItemsPhaseToken({ moduleIds: missingModuleIds, itemToken: null, modulesToken: next })
            : nextActivityToken(phase.phase, next),
          pageNumber: input.page.pageNumber,
        };
      }, { kind: 'activities', urlPolicy: dependencies.urlPolicy }, dependencies.now, received.deadlineAt);
    },

    async syncResources(input: LearningSyncResourcesRequest) {
      if (input.page.pageNumber !== 1 || input.page.pageToken !== null) learningValidation.invalid();
      const courseId = input.subject.externalCourseId;
      const activityId = input.subject.externalActivityId;
      if (!activityId.startsWith('module:')) {
        return readAndNormalizeLearningPage(new Response('[]', {
          headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
        }), input.operation, () => ({
          items: [], requestPageToken: null, nextPageToken: null, pageNumber: 1,
        }), { kind: 'resources', urlPolicy: dependencies.urlPolicy }, dependencies.now);
      }
      const ids = moduleItemIds(activityId);
      const itemResponse = await request(endpoint(
        baseUrl,
        `/api/v1/courses/${encodeURIComponent(courseId)}/modules/${encodeURIComponent(ids.moduleId)}/items/${encodeURIComponent(ids.itemId)}`,
      ), input.operation);
      const item = data(await readBoundedJson(
        itemResponse.response, input.operation, dependencies.now, itemResponse.deadlineAt,
      ));
      if (externalId(item.id) !== ids.itemId) learningValidation.invalid();
      const type = string(item.type, 64);
      const title = string(item.title, LEARNING_LIMITS.titleBytes);
      let resource: LearningResource;
      if (type === 'ExternalUrl') {
        const canvasLaunchUrl = string(item.html_url, LEARNING_LIMITS.urlBytes);
        const externalLaunchUrl = string(item.external_url, LEARNING_LIMITS.urlBytes);
        try {
          const youtube = normalizeYouTube(externalLaunchUrl);
          resource = Object.freeze({
            connectionId, provider: 'canvas', externalCourseId: courseId, externalActivityId: activityId,
            externalResourceId: `youtube:${youtube.videoId}`, title, kind: 'youtube', launchUrl: youtube.embedUrl,
            youtubeVideoId: youtube.videoId, mimeType: null, sizeBytes: null, providerUpdatedAt: null,
          });
        } catch {
          resource = Object.freeze({
            connectionId, provider: 'canvas', externalCourseId: courseId, externalActivityId: activityId,
            externalResourceId: stableResourceId('link', canvasLaunchUrl), title, kind: 'link',
            launchUrl: canvasLaunchUrl, youtubeVideoId: null, mimeType: null, sizeBytes: null,
            providerUpdatedAt: null,
          });
        }
      } else if (type === 'ExternalTool') {
        resource = Object.freeze({
          connectionId, provider: 'canvas', externalCourseId: courseId, externalActivityId: activityId,
          externalResourceId: stableResourceId('tool', string(item.html_url, LEARNING_LIMITS.urlBytes)),
          title, kind: 'provider_file', launchUrl: string(item.html_url, LEARNING_LIMITS.urlBytes),
          youtubeVideoId: null, mimeType: null, sizeBytes: null, providerUpdatedAt: null,
        });
      } else if (type === 'Page') {
        const pageUrlValue = string(item.page_url, LEARNING_LIMITS.externalIdBytes);
        const detailResponse = await request(endpoint(
          baseUrl,
          `/api/v1/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(pageUrlValue)}`,
        ), input.operation);
        const detail = data(await readBoundedJson(
          detailResponse.response, input.operation, dependencies.now, detailResponse.deadlineAt,
        ));
        if (string(detail.url, LEARNING_LIMITS.externalIdBytes) !== pageUrlValue) learningValidation.invalid();
        resource = linkResource(connectionId, courseId, activityId,
          string(detail.title, LEARNING_LIMITS.titleBytes),
          string(detail.html_url, LEARNING_LIMITS.urlBytes), nullableTimestamp(detail.updated_at));
      } else if (type === 'File') {
        const fileId = externalId(item.content_id);
        const detailResponse = await request(endpoint(baseUrl, `/api/v1/files/${encodeURIComponent(fileId)}`), input.operation);
        const detail = data(await readBoundedJson(
          detailResponse.response, input.operation, dependencies.now, detailResponse.deadlineAt,
        ));
        if (externalId(detail.id) !== fileId) learningValidation.invalid();
        resource = Object.freeze({
          connectionId, provider: 'canvas', externalCourseId: courseId, externalActivityId: activityId,
          externalResourceId: `file:${fileId}`,
          title: string(detail.display_name, LEARNING_LIMITS.titleBytes),
          kind: 'provider_file',
          launchUrl: string(item.html_url, LEARNING_LIMITS.urlBytes),
          youtubeVideoId: null,
          mimeType: detail['content-type'] === null || detail['content-type'] === undefined
            ? null : string(detail['content-type'], LEARNING_LIMITS.mimeTypeBytes),
          sizeBytes: detail.size === null || detail.size === undefined
            ? null : learningValidation.integer(detail.size, 0, Number.MAX_SAFE_INTEGER),
          providerUpdatedAt: nullableTimestamp(detail.updated_at),
        });
      } else return learningValidation.invalid();
      return readAndNormalizeLearningPage(new Response(JSON.stringify([resource]), {
        headers: { 'Content-Type': 'application/json' },
      }), input.operation, (value) => ({
        items: learningValidation.dataArray(value, 1),
        requestPageToken: null, nextPageToken: null, pageNumber: 1,
      }), { kind: 'resources', urlPolicy: dependencies.urlPolicy }, dependencies.now);
    },

    async syncSubmissions(input: LearningSyncSubmissionsRequest) {
      if (input.subject.externalEnrollmentId !== null) learningValidation.invalid();
      const courseId = input.subject.externalCourseId;
      const activityId = input.subject.externalActivityId;
      const assignmentId = assignmentIdFromActivity(activityId);
      const path = `/api/v1/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submissions`;
      const url = pageUrl(baseUrl, path, input.page.pageSize, input.page.pageToken);
      const received = await request(url, input.operation);
      const next = nextLink(received.response, baseUrl, path);
      return readAndNormalizeLearningPage(received.response, input.operation, (value) => ({
        items: learningValidation.dataArray(value, LEARNING_LIMITS.maxPageItems)
          .map((item) => mapSubmission(item, connectionId, courseId, activityId)),
        requestPageToken: input.page.pageToken,
        nextPageToken: next,
        pageNumber: input.page.pageNumber,
      }), { kind: 'provider_submissions' }, dependencies.now, received.deadlineAt);
    },

    async buildLaunchUrl(input: LearningBuildLaunchRequest) {
      const activityId = 'externalActivityId' in input.subject ? input.subject.externalActivityId : null;
      return Object.freeze({
        connectionId,
        provider: 'canvas',
        externalCourseId: input.subject.externalCourseId,
        externalActivityId: activityId,
        url: activityLaunch(baseUrl, input.subject.externalCourseId, activityId),
      }) as unknown as LearningLaunchContract;
    },

    async normalizeNotification(
      input: LearningNormalizeNotificationRequest,
    ): Promise<LearningProviderNotification> {
      const row = learningValidation.exactRecord(input.payload, [
        'sourceEventId', 'externalCourseId', 'receivedAt',
      ]);
      return Object.freeze({
        connectionId,
        provider: 'canvas',
        sourceEventId: externalId(row.sourceEventId),
        externalCourseId: externalId(row.externalCourseId),
        receivedAt: learningValidation.timestamp(row.receivedAt),
      });
    },
  };
  return Object.freeze(adapter);
}
