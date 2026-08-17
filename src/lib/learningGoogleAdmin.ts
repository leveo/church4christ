import type { AppDb } from './appDb';
import { getLearningConnection } from './learningConnectionDb';
import {
  LearningGoogleAuthConflictError,
  loadGoogleCredential,
  refreshGoogleAccessToken,
  rotateGoogleCredential,
} from './learningGoogleAuth';
import type { LearningCredentialKeyRing } from './learningCredentials';
import {
  mapLearningCourse,
  type LearningMappedCourseRecord,
  type LearningProgramRecord,
} from './learningDb';
import { createGoogleClassroomProvider } from './learningGoogleProvider';
import {
  LEARNING_LIMITS,
  learningValidation,
  type LearningConnectionUrlPolicy,
  type LearningCourse,
} from './learningModel';
import {
  invokeLearningProvider,
  type LearningOperationContext,
  type LearningProviderPage,
} from './learningProvider';

const GOOGLE_POLICY = Object.freeze({
  providerLaunchOrigins: Object.freeze(['https://classroom.google.com']),
  providerFileOrigins: Object.freeze(['https://drive.google.com', 'https://docs.google.com']),
  externalLinkOrigins: Object.freeze(['https://forms.gle', 'https://forms.google.com']),
});
const MAX_ADMIN_COURSES = 1_000;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;

export class LearningGoogleAdminError extends Error {
  readonly code = 'learning_google_admin_failed' as const;
  constructor() {
    super('learning_google_admin_failed');
    this.name = 'LearningGoogleAdminError';
  }
}

const invalid = (): never => { throw new LearningGoogleAdminError(); };

type AdminFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface GoogleAdminEnvironment {
  readonly connectionId: number;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly keyRing: LearningCredentialKeyRing;
  readonly fetcher: AdminFetcher;
  readonly nowEpochMs: number;
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > LEARNING_LIMITS.databaseInteger) invalid();
  return value as number;
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function externalId(value: unknown): string {
  try { return learningValidation.externalId(value); } catch { return invalid(); }
}

function environment(value: GoogleAdminEnvironment): GoogleAdminEnvironment {
  let row: Record<string, unknown>;
  try {
    row = learningValidation.exactRecord(value, [
      'connectionId', 'clientId', 'clientSecret', 'keyRing', 'fetcher', 'nowEpochMs',
    ]);
  } catch { return invalid(); }
  if (typeof row.clientId !== 'string' || typeof row.clientSecret !== 'string' || typeof row.fetcher !== 'function') invalid();
  return Object.freeze({
    connectionId: integer(row.connectionId),
    clientId: row.clientId as string,
    clientSecret: row.clientSecret as string,
    keyRing: row.keyRing as LearningCredentialKeyRing,
    fetcher: row.fetcher as AdminFetcher,
    nowEpochMs: epoch(row.nowEpochMs),
  });
}

function urlPolicy(connectionId: number): LearningConnectionUrlPolicy {
  return Object.freeze({
    connectionId,
    provider: 'google_classroom',
    baseUrl: null,
    ...GOOGLE_POLICY,
  });
}

function operation(
  connectionId: number,
  nowEpochMs: number,
  externalCourseId: string | null,
): LearningOperationContext {
  return Object.freeze({
    scope: Object.freeze({
      connectionId,
      provider: 'google_classroom' as const,
      externalCourseId,
      externalActivityId: null,
      externalEnrollmentId: null,
    }),
    startedAt: new Date(nowEpochMs).toISOString(),
    deadlineAt: new Date(nowEpochMs + 30_000).toISOString(),
    maxPages: 20,
    maxItems: MAX_ADMIN_COURSES,
    maxRawBytes: LEARNING_LIMITS.maxSyncBytes,
    maxNormalizedBytes: LEARNING_LIMITS.maxSyncBytes,
    maxUniqueKeyBytes: LEARNING_LIMITS.maxSyncBytes,
    signal: new AbortController().signal,
  });
}

async function activeAccessToken(
  db: AppDb,
  input: GoogleAdminEnvironment,
): Promise<string> {
  const connection = await getLearningConnection(db, input.connectionId, { includeDeleted: false });
  if (!connection || connection.provider !== 'google_classroom' || connection.status !== 'active') invalid();
  let loaded = await loadGoogleCredential(db, { connectionId: input.connectionId, keyRing: input.keyRing });
  if (Date.parse(loaded.credential.accessTokenExpiresAt) > input.nowEpochMs + REFRESH_SKEW_MS) {
    return loaded.credential.accessToken;
  }
  const credential = await refreshGoogleAccessToken({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: loaded.credential.refreshToken,
    fetcher: input.fetcher,
    signal: new AbortController().signal,
    nowEpochMs: input.nowEpochMs,
  });
  try {
    await rotateGoogleCredential(db, {
      connectionId: input.connectionId,
      expectedRevision: loaded.revision,
      credential,
      keyRing: input.keyRing,
      nowEpochMs: input.nowEpochMs,
    });
    return credential.accessToken;
  } catch (error) {
    if (!(error instanceof LearningGoogleAuthConflictError)) throw error;
    loaded = await loadGoogleCredential(db, { connectionId: input.connectionId, keyRing: input.keyRing });
    if (Date.parse(loaded.credential.accessTokenExpiresAt) <= input.nowEpochMs) invalid();
    return loaded.credential.accessToken;
  }
}

async function providerContext(db: AppDb, rawInput: GoogleAdminEnvironment) {
  const input = environment(rawInput);
  const policy = urlPolicy(input.connectionId);
  const accessToken = await activeAccessToken(db, input);
  return Object.freeze({
    input,
    policy,
    provider: createGoogleClassroomProvider({
      connectionId: input.connectionId,
      accessToken,
      urlPolicy: policy,
      fetcher: input.fetcher,
      now: () => input.nowEpochMs,
    }),
  });
}

async function activePrograms(db: AppDb): Promise<readonly LearningProgramRecord[]> {
  const result = await db.prepare(`SELECT id AS program_id,slug,display_name,status
    FROM learning_programs WHERE status='active' AND deleted_at IS NULL
    ORDER BY display_name,id LIMIT 100`).all<Record<string, unknown>>();
  if (!result || !Array.isArray(result.results) || result.results.length > 100) invalid();
  return Object.freeze(result.results.map((row) => {
    if (row.status !== 'active') invalid();
    return Object.freeze({
      programId: integer(row.program_id),
      slug: learningValidation.boundedString(row.slug, 1, 64),
      displayName: learningValidation.boundedString(row.display_name, 1, 200),
      status: 'active' as const,
    });
  }));
}

async function mappedPrograms(
  db: AppDb,
  connectionId: number,
): Promise<Map<string, number>> {
  const result = await db.prepare(`SELECT external_course_id,program_id FROM learning_courses
    WHERE connection_id=?1 AND provider='google_classroom' AND deleted_at IS NULL
    ORDER BY external_course_id LIMIT 1000`).bind(connectionId).all<Record<string, unknown>>();
  if (!result || !Array.isArray(result.results) || result.results.length > MAX_ADMIN_COURSES) invalid();
  const mapped = new Map<string, number>();
  for (const row of result.results) mapped.set(externalId(row.external_course_id), integer(row.program_id));
  return mapped;
}

export interface GoogleClassroomCourseOption {
  readonly course: LearningCourse;
  readonly mappedProgramId: number | null;
}

export interface GoogleClassroomCourseOptions {
  readonly programs: readonly LearningProgramRecord[];
  readonly courses: readonly GoogleClassroomCourseOption[];
}

export async function listGoogleClassroomCourseOptions(
  db: AppDb,
  rawInput: GoogleAdminEnvironment,
): Promise<GoogleClassroomCourseOptions> {
  try {
    const context = await providerContext(db, rawInput);
    const programs = await activePrograms(db);
    const mapped = await mappedPrograms(db, context.input.connectionId);
    const courses: LearningCourse[] = [];
    let pageToken: string | null = null;
    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      const page: LearningProviderPage<LearningCourse> = await invokeLearningProvider(context.provider, {
        method: 'listCourses',
        request: {
          subject: { connectionId: context.input.connectionId, provider: 'google_classroom' },
          page: { pageSize: 100, pageNumber, pageToken },
          operation: operation(context.input.connectionId, context.input.nowEpochMs, null),
        },
        urlPolicy: context.policy,
        now: () => context.input.nowEpochMs + 1,
      });
      courses.push(...page.items);
      if (courses.length > MAX_ADMIN_COURSES) invalid();
      pageToken = page.nextPageToken;
      if (pageToken === null) break;
      if (pageNumber === 20) invalid();
    }
    return Object.freeze({
      programs,
      courses: Object.freeze(courses.map((course) => Object.freeze({
        course,
        mappedProgramId: mapped.get(course.externalCourseId) ?? null,
      }))),
    });
  } catch (error) {
    if (error instanceof LearningGoogleAdminError) throw error;
    return invalid();
  }
}

export async function mapSelectedGoogleClassroomCourse(
  db: AppDb,
  rawInput: GoogleAdminEnvironment & {
    readonly externalCourseId: string;
    readonly programId: number;
    readonly actorPersonId: number;
  },
): Promise<LearningMappedCourseRecord> {
  let input: Record<string, unknown>;
  try {
    input = learningValidation.exactRecord(rawInput, [
      'connectionId', 'clientId', 'clientSecret', 'keyRing', 'fetcher', 'nowEpochMs',
      'externalCourseId', 'programId', 'actorPersonId',
    ]);
  } catch { return invalid(); }
  const adminEnvironment = environment({
    connectionId: input.connectionId as number,
    clientId: input.clientId as string,
    clientSecret: input.clientSecret as string,
    keyRing: input.keyRing as LearningCredentialKeyRing,
    fetcher: input.fetcher as AdminFetcher,
    nowEpochMs: input.nowEpochMs as number,
  });
  const externalCourseId = externalId(input.externalCourseId);
  const programId = integer(input.programId);
  integer(input.actorPersonId);
  try {
    const context = await providerContext(db, adminEnvironment);
    const course = await invokeLearningProvider(context.provider, {
      method: 'syncCourse',
      request: {
        subject: {
          connectionId: adminEnvironment.connectionId,
          provider: 'google_classroom',
          externalCourseId,
        },
        operation: operation(adminEnvironment.connectionId, adminEnvironment.nowEpochMs, externalCourseId),
      },
      urlPolicy: context.policy,
      now: () => adminEnvironment.nowEpochMs + 1,
    });
    return await mapLearningCourse(db, { programId, course, urlPolicy: context.policy });
  } catch (error) {
    if (error instanceof LearningGoogleAdminError) throw error;
    return invalid();
  }
}
