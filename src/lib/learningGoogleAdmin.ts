import type { AppDb } from './appDb';
import {
  LearningConnectionConflictError,
  disconnectLearningConnection,
  getLearningConnection,
  type LearningConnectionRecord,
} from './learningConnectionDb';
import {
  LearningGoogleAuthConflictError,
  loadGoogleCredential,
  refreshGoogleAccessToken,
  revokeGoogleRefreshToken,
  rotateGoogleCredential,
} from './learningGoogleAuth';
import type { LearningCredentialKeyRing } from './learningCredentials';
import {
  type LearningMappedCourseRecord,
  type LearningProgramRecord,
} from './learningDb';
import { createGoogleClassroomProvider } from './learningGoogleProvider';
import {
  commitGoogleClassroomCourseMapping,
  commitGoogleClassroomCourseUnmap,
  LearningGoogleRegistrationLifecycleConflictError,
  loadGoogleClassroomCourseRegistrationIds,
} from './learningGoogleRegistrationLifecycle';
import {
  createGoogleClassroomRegistration,
  deleteGoogleClassroomRegistration,
  GOOGLE_CLASSROOM_FEED_TYPES,
  type GoogleClassroomRegistration,
} from './learningGooglePubSub';
import {
  LEARNING_LIMITS,
  LearningProviderError,
  learningValidation,
  type LearningConnectionUrlPolicy,
  type LearningCourse,
  type LearningErrorCode,
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
): Promise<{
  readonly accessToken: string;
  readonly revision: number;
  readonly refreshTokenExpiresAt: string | null;
}> {
  const connection = await getLearningConnection(db, input.connectionId, { includeDeleted: false });
  if (!connection || connection.provider !== 'google_classroom' || connection.status !== 'active') invalid();
  let loaded = await loadGoogleCredential(db, { connectionId: input.connectionId, keyRing: input.keyRing });
  if (Date.parse(loaded.credential.accessTokenExpiresAt) > input.nowEpochMs + REFRESH_SKEW_MS) {
    return Object.freeze({
      accessToken: loaded.credential.accessToken,
      revision: loaded.revision,
      refreshTokenExpiresAt: loaded.credential.refreshTokenExpiresAt,
    });
  }
  const credential = await refreshGoogleAccessToken({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: loaded.credential.refreshToken,
    refreshTokenExpiresAt: loaded.credential.refreshTokenExpiresAt,
    fetcher: input.fetcher,
    signal: new AbortController().signal,
    nowEpochMs: input.nowEpochMs,
  });
  try {
    const rotated = await rotateGoogleCredential(db, {
      connectionId: input.connectionId,
      expectedRevision: loaded.revision,
      credential,
      keyRing: input.keyRing,
      nowEpochMs: input.nowEpochMs,
    });
    return Object.freeze({
      accessToken: credential.accessToken,
      revision: rotated.revision,
      refreshTokenExpiresAt: credential.refreshTokenExpiresAt,
    });
  } catch (error) {
    if (!(error instanceof LearningGoogleAuthConflictError)) throw error;
    loaded = await loadGoogleCredential(db, { connectionId: input.connectionId, keyRing: input.keyRing });
    if (Date.parse(loaded.credential.accessTokenExpiresAt) <= input.nowEpochMs) invalid();
    return Object.freeze({
      accessToken: loaded.credential.accessToken,
      revision: loaded.revision,
      refreshTokenExpiresAt: loaded.credential.refreshTokenExpiresAt,
    });
  }
}

async function providerContext(db: AppDb, rawInput: GoogleAdminEnvironment) {
  const input = environment(rawInput);
  const policy = urlPolicy(input.connectionId);
  const access = await activeAccessToken(db, input);
  return Object.freeze({
    input,
    policy,
    access,
    provider: createGoogleClassroomProvider({
      connectionId: input.connectionId,
      accessToken: access.accessToken,
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
  readonly connectionRevision: number;
  readonly reconnectDeadline: string | null;
}

export type GoogleClassroomHealthResult =
  | { readonly ok: true; readonly errorCode: null }
  | { readonly ok: false; readonly errorCode: LearningErrorCode };

export async function checkGoogleClassroomConnectionHealth(
  db: AppDb,
  rawInput: GoogleAdminEnvironment,
): Promise<GoogleClassroomHealthResult> {
  try {
    const context = await providerContext(db, rawInput);
    await invokeLearningProvider(context.provider, {
      method: 'healthCheck',
      request: {
        subject: { connectionId: context.input.connectionId, provider: 'google_classroom' },
        operation: operation(context.input.connectionId, context.input.nowEpochMs, null),
      },
      now: () => context.input.nowEpochMs + 1,
    });
    return Object.freeze({ ok: true, errorCode: null });
  } catch (error) {
    if (error instanceof LearningProviderError) {
      return Object.freeze({ ok: false, errorCode: error.code });
    }
    return Object.freeze({ ok: false, errorCode: 'authentication_required' });
  }
}

export async function disconnectGoogleClassroomConnection(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly actorPersonId: number;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: AdminFetcher;
    readonly nowEpochMs: number;
  },
): Promise<LearningConnectionRecord> {
  let input: Record<string, unknown>;
  try {
    input = learningValidation.exactRecord(rawInput, [
      'connectionId', 'expectedRevision', 'actorPersonId', 'keyRing', 'fetcher',
      'clientId', 'clientSecret', 'nowEpochMs',
    ]);
  } catch { return invalid(); }
  const connectionId = integer(input.connectionId);
  const expectedRevision = learningValidation.integer(input.expectedRevision, 0, LEARNING_LIMITS.databaseInteger);
  const actorPersonId = integer(input.actorPersonId);
  if (typeof input.fetcher !== 'function') invalid();
  const connection = await getLearningConnection(db, connectionId, { includeDeleted: false });
  if (
    !connection
    || connection.provider !== 'google_classroom'
    || connection.revision !== expectedRevision
    || connection.status === 'disabled'
  ) throw new LearningConnectionConflictError();
  const adminEnvironment = environment({
    connectionId,
    clientId: input.clientId as string,
    clientSecret: input.clientSecret as string,
    keyRing: input.keyRing as LearningCredentialKeyRing,
    fetcher: input.fetcher as AdminFetcher,
    nowEpochMs: input.nowEpochMs as number,
  });
  const access = await activeAccessToken(db, adminEnvironment);
  if (access.revision !== expectedRevision) throw new LearningConnectionConflictError();
  const registrationResult = await db.prepare(`SELECT registration_id FROM learning_google_registrations
    WHERE connection_id=?1 ORDER BY external_course_id,feed_type LIMIT 2001`)
    .bind(connectionId).all<Record<string, unknown>>();
  if (
    !registrationResult || !Array.isArray(registrationResult.results)
    || registrationResult.results.length > 2_000
  ) invalid();
  const registrationIds = registrationResult.results.map((row) => externalId(row.registration_id));
  const cleanupController = new AbortController();
  const cleanupTimer = setTimeout(() => cleanupController.abort(), 25_000);
  let cursor = 0;
  try {
    const workers = Array.from({ length: Math.min(8, registrationIds.length) }, async () => {
      while (cursor < registrationIds.length) {
        const registrationId = registrationIds[cursor];
        cursor += 1;
        await deleteGoogleClassroomRegistration({
          accessToken: access.accessToken,
          registrationId,
          fetcher: adminEnvironment.fetcher,
          signal: cleanupController.signal,
        });
      }
    });
    await Promise.all(workers);
  } catch (error) {
    cleanupController.abort();
    throw error;
  } finally {
    clearTimeout(cleanupTimer);
  }
  const loaded = await loadGoogleCredential(db, {
    connectionId,
    keyRing: input.keyRing as LearningCredentialKeyRing,
  });
  if (loaded.revision !== expectedRevision) throw new LearningConnectionConflictError();
  await revokeGoogleRefreshToken({
    refreshToken: loaded.credential.refreshToken,
    fetcher: input.fetcher as AdminFetcher,
    signal: new AbortController().signal,
  });
  return disconnectLearningConnection(db, { connectionId, expectedRevision, actorPersonId });
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
      connectionRevision: context.access.revision,
      reconnectDeadline: context.access.refreshTokenExpiresAt,
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
    readonly expectedRevision: number;
    readonly pushTopicName: string | null;
  },
): Promise<LearningMappedCourseRecord> {
  let input: Record<string, unknown>;
  try {
    input = learningValidation.exactRecord(rawInput, [
      'connectionId', 'clientId', 'clientSecret', 'keyRing', 'fetcher', 'nowEpochMs',
      'externalCourseId', 'programId', 'actorPersonId', 'expectedRevision', 'pushTopicName',
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
  const actorPersonId = integer(input.actorPersonId);
  const expectedRevision = learningValidation.integer(input.expectedRevision, 0, LEARNING_LIMITS.databaseInteger);
  const pushTopicName = input.pushTopicName === null
    ? null
    : learningValidation.boundedString(input.pushTopicName, 20, 512);
  try {
    const context = await providerContext(db, adminEnvironment);
    if (context.access.revision !== expectedRevision) {
      throw new LearningGoogleRegistrationLifecycleConflictError();
    }
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
    const registrations: GoogleClassroomRegistration[] = [];
    try {
      const replacedRegistrationIds = await loadGoogleClassroomCourseRegistrationIds(db, {
        connectionId: adminEnvironment.connectionId,
        expectedRevision,
        externalCourseId,
      });
      if (pushTopicName !== null) {
        for (const feedType of GOOGLE_CLASSROOM_FEED_TYPES) {
          registrations.push(await createGoogleClassroomRegistration({
            accessToken: context.access.accessToken,
            externalCourseId,
            feedType,
            topicName: pushTopicName,
            fetcher: adminEnvironment.fetcher,
            signal: new AbortController().signal,
            nowEpochMs: adminEnvironment.nowEpochMs,
          }));
        }
      }
      for (const registrationId of replacedRegistrationIds) {
        await deleteGoogleClassroomRegistration({
          accessToken: context.access.accessToken,
          registrationId,
          fetcher: adminEnvironment.fetcher,
          signal: new AbortController().signal,
        });
      }
      const committed = await commitGoogleClassroomCourseMapping(db, {
        connectionId: adminEnvironment.connectionId,
        expectedRevision,
        programId,
        actorPersonId,
        course,
        urlPolicy: context.policy,
        expectedRegistrationIds: replacedRegistrationIds,
        registrations,
        nowEpochMs: adminEnvironment.nowEpochMs,
      });
      return committed.mappedCourse;
    } catch (error) {
      for (const registration of registrations) {
        try {
          await deleteGoogleClassroomRegistration({
            accessToken: context.access.accessToken,
            registrationId: registration.registrationId,
            fetcher: adminEnvironment.fetcher,
            signal: new AbortController().signal,
          });
        } catch { /* bounded provider expiry is the final cleanup fallback */ }
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof LearningGoogleAdminError) throw error;
    return invalid();
  }
}

export async function unmapSelectedGoogleClassroomCourse(
  db: AppDb,
  rawInput: GoogleAdminEnvironment & {
    readonly externalCourseId: string;
    readonly actorPersonId: number;
    readonly expectedRevision: number;
  },
): Promise<{ readonly connectionId: number; readonly connectionRevision: number }> {
  let input: Record<string, unknown>;
  try {
    input = learningValidation.exactRecord(rawInput, [
      'connectionId', 'clientId', 'clientSecret', 'keyRing', 'fetcher', 'nowEpochMs',
      'externalCourseId', 'actorPersonId', 'expectedRevision',
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
  const actorPersonId = integer(input.actorPersonId);
  const expectedRevision = learningValidation.integer(input.expectedRevision, 0, LEARNING_LIMITS.databaseInteger);
  try {
    const context = await providerContext(db, adminEnvironment);
    if (context.access.revision !== expectedRevision) {
      throw new LearningGoogleRegistrationLifecycleConflictError();
    }
    const removedRegistrationIds = await loadGoogleClassroomCourseRegistrationIds(db, {
      connectionId: adminEnvironment.connectionId,
      expectedRevision,
      externalCourseId,
    });
    for (const registrationId of removedRegistrationIds) {
      await deleteGoogleClassroomRegistration({
        accessToken: context.access.accessToken,
        registrationId,
        fetcher: adminEnvironment.fetcher,
        signal: new AbortController().signal,
      });
    }
    const committed = await commitGoogleClassroomCourseUnmap(db, {
      connectionId: adminEnvironment.connectionId,
      expectedRevision,
      actorPersonId,
      externalCourseId,
      expectedRegistrationIds: removedRegistrationIds,
      nowEpochMs: adminEnvironment.nowEpochMs,
    });
    return Object.freeze({
      connectionId: committed.connectionId,
      connectionRevision: committed.connectionRevision,
    });
  } catch (error) {
    if (error instanceof LearningGoogleAdminError) throw error;
    return invalid();
  }
}
