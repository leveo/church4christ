import type { AppDb, AppStatement } from './appDb';
import {
  LearningCanvasAuthConflictError,
  loadCanvasCredential,
  loadCanvasCredentialForAdmin,
  refreshCanvasAccessToken,
  revokeCanvasAccessToken,
  rotateCanvasCredential,
} from './learningCanvasAuth';
import { createCanvasProvider } from './learningCanvasProvider';
import type { LearningCredentialKeyRing } from './learningCredentials';
import {
  disconnectLearningConnection,
  getLearningConnection,
  type LearningConnectionRecord,
} from './learningConnectionDb';
import type { LearningMappedCourseRecord, LearningProgramRecord } from './learningDb';
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
import { requireAllowedCanvasOrigin } from './learningCanvasOrigins';

const MAX_ADMIN_COURSES = 1_000;
const REFRESH_SKEW_MS = 5 * 60 * 1_000;
type AdminFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class LearningCanvasAdminError extends Error {
  readonly code = 'learning_canvas_admin_failed' as const;
  constructor() { super('learning_canvas_admin_failed'); this.name = 'LearningCanvasAdminError'; }
}

export class LearningCanvasAdminConflictError extends Error {
  readonly code = 'learning_canvas_admin_conflict' as const;
  constructor() { super('learning_canvas_admin_conflict'); this.name = 'LearningCanvasAdminConflictError'; }
}

const invalid = (): never => { throw new LearningCanvasAdminError(); };

interface CanvasAdminEnvironment {
  readonly connectionId: number;
  readonly allowedOrigins: readonly string[];
  readonly clientId: string;
  readonly clientSecret: string;
  readonly keyRing: LearningCredentialKeyRing;
  readonly fetcher: AdminFetcher;
  readonly nowEpochMs: number;
}

function integer(value: unknown, minimum = 1): number {
  try { return learningValidation.integer(value, minimum, LEARNING_LIMITS.databaseInteger); } catch { return invalid(); }
}

function externalId(value: unknown): string {
  try { return learningValidation.externalId(value); } catch { return invalid(); }
}

function environment(value: CanvasAdminEnvironment): CanvasAdminEnvironment {
  let row: Record<string, unknown>;
  try {
    row = learningValidation.exactRecord(value, [
      'connectionId', 'allowedOrigins', 'clientId', 'clientSecret', 'keyRing', 'fetcher', 'nowEpochMs',
    ]);
  } catch { return invalid(); }
  if (
    typeof row.clientId !== 'string' || row.clientId.length < 1
    || typeof row.clientSecret !== 'string' || row.clientSecret.length < 1
    || typeof row.fetcher !== 'function'
    || !Number.isSafeInteger(row.nowEpochMs) || (row.nowEpochMs as number) < 0
  ) invalid();
  if (!Array.isArray(row.allowedOrigins) || !Object.isFrozen(row.allowedOrigins)) invalid();
  return Object.freeze({
    connectionId: integer(row.connectionId),
    allowedOrigins: row.allowedOrigins as readonly string[],
    clientId: row.clientId as string,
    clientSecret: row.clientSecret as string,
    keyRing: row.keyRing as LearningCredentialKeyRing,
    fetcher: row.fetcher as AdminFetcher,
    nowEpochMs: row.nowEpochMs as number,
  });
}

function urlPolicy(connectionId: number, baseUrl: string): LearningConnectionUrlPolicy {
  return Object.freeze({
    connectionId, provider: 'canvas', baseUrl,
    providerLaunchOrigins: Object.freeze([baseUrl]),
    providerFileOrigins: Object.freeze([baseUrl]),
    externalLinkOrigins: Object.freeze([baseUrl]),
  });
}

function operation(
  connectionId: number,
  nowEpochMs: number,
  externalCourseId: string | null,
): LearningOperationContext {
  return Object.freeze({
    scope: Object.freeze({
      connectionId, provider: 'canvas' as const, externalCourseId,
      externalActivityId: null, externalEnrollmentId: null,
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

async function providerContext(db: AppDb, rawInput: CanvasAdminEnvironment, allowError = false) {
  const input = environment(rawInput);
  const connection = (await getLearningConnection(db, input.connectionId, { includeDeleted: false })) ?? invalid();
  if (
    connection.provider !== 'canvas'
    || (connection.status !== 'active' && (!allowError || connection.status !== 'error'))
  ) invalid();
  let loaded = allowError
    ? await loadCanvasCredentialForAdmin(db, { connectionId: input.connectionId, keyRing: input.keyRing })
    : await loadCanvasCredential(db, { connectionId: input.connectionId, keyRing: input.keyRing });
  requireAllowedCanvasOrigin(loaded.baseUrl, input.allowedOrigins);
  if (Date.parse(loaded.credential.accessTokenExpiresAt) <= input.nowEpochMs + REFRESH_SKEW_MS) {
    const credential = await refreshCanvasAccessToken({
      baseUrl: loaded.baseUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: loaded.credential.refreshToken,
      fetcher: input.fetcher,
      signal: new AbortController().signal,
      nowEpochMs: input.nowEpochMs,
    });
    try {
      const rotated = await rotateCanvasCredential(db, {
        connectionId: input.connectionId, expectedRevision: loaded.revision,
        credential, keyRing: input.keyRing, nowEpochMs: input.nowEpochMs,
        allowErrorStatus: connection.status === 'error',
      });
      loaded = Object.freeze({ ...loaded, revision: rotated.revision, credential });
    } catch (error) {
      if (!(error instanceof LearningCanvasAuthConflictError)) throw error;
      loaded = allowError
        ? await loadCanvasCredentialForAdmin(db, {
          connectionId: input.connectionId, keyRing: input.keyRing,
        })
        : await loadCanvasCredential(db, {
          connectionId: input.connectionId, keyRing: input.keyRing,
        });
      if (Date.parse(loaded.credential.accessTokenExpiresAt) <= input.nowEpochMs) invalid();
    }
  }
  const policy = urlPolicy(input.connectionId, loaded.baseUrl);
  return Object.freeze({
    input, connection, loaded, policy,
    provider: createCanvasProvider({
      connectionId: input.connectionId,
      baseUrl: loaded.baseUrl,
      accessToken: loaded.credential.accessToken,
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
  return Object.freeze(result.results.map((row) => Object.freeze({
    programId: integer(row.program_id),
    slug: learningValidation.boundedString(row.slug, 1, 64),
    displayName: learningValidation.boundedString(row.display_name, 1, 200),
    status: row.status === 'active' ? 'active' as const : invalid(),
  })));
}

export type CanvasHealthResult =
  | { readonly ok: true; readonly errorCode: null; readonly connectionRevision: number }
  | { readonly ok: false; readonly errorCode: LearningErrorCode; readonly connectionRevision: number | null };

export async function checkCanvasConnectionHealth(
  db: AppDb,
  rawInput: CanvasAdminEnvironment,
): Promise<CanvasHealthResult> {
  let connectionRevision: number | null = null;
  try {
    const context = await providerContext(db, rawInput, true);
    connectionRevision = context.loaded.revision;
    await invokeLearningProvider(context.provider, {
      method: 'healthCheck',
      request: {
        subject: { connectionId: context.input.connectionId, provider: 'canvas' },
        operation: operation(context.input.connectionId, context.input.nowEpochMs, null),
      },
      now: () => context.input.nowEpochMs + 1,
    });
    return Object.freeze({ ok: true, errorCode: null, connectionRevision });
  } catch (error) {
    return Object.freeze({
      ok: false,
      errorCode: error instanceof LearningProviderError ? error.code : 'authentication_required',
      connectionRevision,
    });
  }
}

export interface CanvasCourseOption {
  readonly course: LearningCourse;
  readonly mappedProgramId: number | null;
}

export async function listCanvasCourseOptions(db: AppDb, rawInput: CanvasAdminEnvironment): Promise<{
  readonly programs: readonly LearningProgramRecord[];
  readonly courses: readonly CanvasCourseOption[];
  readonly connectionRevision: number;
}> {
  try {
    const context = await providerContext(db, rawInput);
    const programs = await activePrograms(db);
    const mappedRows = await db.prepare(`SELECT external_course_id,program_id FROM learning_courses
      WHERE connection_id=?1 AND provider='canvas' AND deleted_at IS NULL
      ORDER BY external_course_id LIMIT 1000`).bind(context.input.connectionId).all<Record<string, unknown>>();
    if (!mappedRows || !Array.isArray(mappedRows.results)) invalid();
    const mapped = new Map(mappedRows.results.map((row) => [externalId(row.external_course_id), integer(row.program_id)]));
    const courses: LearningCourse[] = [];
    let pageToken: string | null = null;
    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      const page: LearningProviderPage<LearningCourse> = await invokeLearningProvider(context.provider, {
        method: 'listCourses',
        request: {
          subject: { connectionId: context.input.connectionId, provider: 'canvas' },
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
      connectionRevision: context.loaded.revision,
      courses: Object.freeze(courses.map((course) => Object.freeze({
        course, mappedProgramId: mapped.get(course.externalCourseId) ?? null,
      }))),
    });
  } catch (error) {
    if (error instanceof LearningCanvasAdminError) throw error;
    return invalid();
  }
}

function resultRows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { results?: unknown }).results)) invalid();
  return (value as { results: Record<string, unknown>[] }).results;
}

export async function mapSelectedCanvasCourse(
  db: AppDb,
  rawInput: CanvasAdminEnvironment & {
    readonly externalCourseId: string;
    readonly programId: number;
    readonly actorPersonId: number;
    readonly expectedRevision: number;
    readonly rootAccountId: string;
  },
): Promise<LearningMappedCourseRecord & { readonly connectionRevision: number }> {
  const input = environment({
    connectionId: rawInput.connectionId, allowedOrigins: rawInput.allowedOrigins, clientId: rawInput.clientId,
    clientSecret: rawInput.clientSecret, keyRing: rawInput.keyRing,
    fetcher: rawInput.fetcher, nowEpochMs: rawInput.nowEpochMs,
  });
  const externalCourseId = externalId(rawInput.externalCourseId);
  const programId = integer(rawInput.programId);
  const actorPersonId = integer(rawInput.actorPersonId);
  const expectedRevision = integer(rawInput.expectedRevision, 0);
  const rootAccountId = externalId(rawInput.rootAccountId);
  const context = await providerContext(db, input);
  if (context.loaded.revision !== expectedRevision) throw new LearningCanvasAdminConflictError();
  const course = await invokeLearningProvider(context.provider, {
    method: 'syncCourse',
    request: {
      subject: { connectionId: input.connectionId, provider: 'canvas', externalCourseId },
      operation: operation(input.connectionId, input.nowEpochMs, externalCourseId),
    },
    urlPolicy: context.policy,
    now: () => input.nowEpochMs + 1,
  });
  const marker = crypto.randomUUID();
  const nextRevision = expectedRevision + 1;
  const statements: AppStatement[] = [
    db.prepare(`UPDATE learning_provider_connections SET operation_marker=?1,
      operation_expires_at=?2,revision=revision+1,updated_by_person_id=?3,updated_at=datetime('now')
      WHERE id=?4 AND provider='canvas' AND status='active' AND revision=?5
        AND deleted_at IS NULL AND operation_marker IS NULL`)
      .bind(marker, new Date(input.nowEpochMs + 30_000).toISOString(), actorPersonId, input.connectionId, expectedRevision),
    db.prepare(`INSERT INTO learning_courses
      (program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state,
       provider_updated_at,last_synced_at,created_at,updated_at)
      SELECT ?1,c.id,'canvas',?2,?3,?4,?5,?6,NULL,datetime('now'),datetime('now')
      FROM learning_provider_connections c JOIN learning_programs p ON p.id=?1
      WHERE c.id=?7 AND c.provider='canvas' AND c.revision=?8 AND c.operation_marker=?9
        AND p.status='active' AND p.deleted_at IS NULL
      ON CONFLICT(connection_id,external_course_id) DO UPDATE SET
        program_id=excluded.program_id,display_name=excluded.display_name,launch_url=excluded.launch_url,
        lifecycle_state=excluded.lifecycle_state,provider_updated_at=excluded.provider_updated_at,
        deleted_at=NULL,updated_at=datetime('now')
      RETURNING id AS course_id,program_id,connection_id,provider,external_course_id,
        display_name,lifecycle_state,last_synced_at`)
      .bind(
        programId, externalCourseId, course.displayName, course.launchUrl, course.lifecycleState,
        course.providerUpdatedAt, input.connectionId, nextRevision, marker,
      ),
    db.prepare(`INSERT INTO learning_canvas_webhook_configs
      (connection_id,root_account_id,verification_mode,jwk_set_url,status,updated_at)
      SELECT id,?1,'instructure_jwt',
        'https://8axpcl50e4.execute-api.us-east-1.amazonaws.com/main/jwks','active',datetime('now')
      FROM learning_provider_connections WHERE id=?2 AND revision=?3 AND operation_marker=?4
      ON CONFLICT(connection_id) DO UPDATE SET root_account_id=excluded.root_account_id,
        status='active',updated_at=datetime('now')`)
      .bind(rootAccountId, input.connectionId, nextRevision, marker),
    db.prepare(`UPDATE learning_provider_connections SET operation_marker=NULL,
      operation_expires_at=NULL,updated_at=datetime('now')
      WHERE id=?1 AND revision=?2 AND operation_marker=?3
      RETURNING id AS connection_id,revision`)
      .bind(input.connectionId, nextRevision, marker),
  ];
  try {
    const results = await db.batch(statements);
    const mappedRows = resultRows(results[1]);
    const connectionRows = resultRows(results[3]);
    if (mappedRows.length !== 1 || connectionRows.length !== 1) throw new LearningCanvasAdminConflictError();
    const row = mappedRows[0];
    return Object.freeze({
      courseId: integer(row.course_id), programId: integer(row.program_id),
      connectionId: integer(row.connection_id), provider: 'canvas',
      externalCourseId: externalId(row.external_course_id),
      displayName: learningValidation.boundedString(row.display_name, 1, LEARNING_LIMITS.courseDisplayNameBytes),
      lifecycleState: row.lifecycle_state === 'active' || row.lifecycle_state === 'archived' || row.lifecycle_state === 'deleted'
        ? row.lifecycle_state : invalid(),
      lastSyncedAt: row.last_synced_at === null ? null : learningValidation.timestamp(row.last_synced_at),
      connectionRevision: integer(connectionRows[0]?.revision),
    });
  } catch (error) {
    if (error instanceof LearningCanvasAdminConflictError) throw error;
    return invalid();
  }
}

export async function unmapSelectedCanvasCourse(
  db: AppDb,
  rawInput: CanvasAdminEnvironment & {
    readonly externalCourseId: string;
    readonly actorPersonId: number;
    readonly expectedRevision: number;
  },
): Promise<{ readonly connectionId: number; readonly connectionRevision: number }> {
  const input = environment({
    connectionId: rawInput.connectionId, allowedOrigins: rawInput.allowedOrigins, clientId: rawInput.clientId,
    clientSecret: rawInput.clientSecret, keyRing: rawInput.keyRing,
    fetcher: rawInput.fetcher, nowEpochMs: rawInput.nowEpochMs,
  });
  const externalCourseId = externalId(rawInput.externalCourseId);
  const actorPersonId = integer(rawInput.actorPersonId);
  const expectedRevision = integer(rawInput.expectedRevision, 0);
  const marker = crypto.randomUUID();
  const nextRevision = expectedRevision + 1;
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=?1,
        operation_expires_at=?2,revision=revision+1,updated_by_person_id=?3,updated_at=datetime('now')
        WHERE id=?4 AND provider='canvas' AND status='active' AND revision=?5
          AND deleted_at IS NULL AND operation_marker IS NULL`)
        .bind(marker, new Date(input.nowEpochMs + 30_000).toISOString(), actorPersonId, input.connectionId, expectedRevision),
      db.prepare(`DELETE FROM learning_courses WHERE connection_id=?1 AND provider='canvas'
        AND external_course_id=?2 AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?3 AND c.operation_marker=?4)
        RETURNING id AS course_id`)
        .bind(input.connectionId, externalCourseId, nextRevision, marker),
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=NULL,
        operation_expires_at=NULL,updated_at=datetime('now')
        WHERE id=?1 AND revision=?2 AND operation_marker=?3
        RETURNING id AS connection_id,revision`)
        .bind(input.connectionId, nextRevision, marker),
    ]);
    if (resultRows(results[1]).length !== 1 || resultRows(results[2]).length !== 1) {
      throw new LearningCanvasAdminConflictError();
    }
    return Object.freeze({ connectionId: input.connectionId, connectionRevision: nextRevision });
  } catch (error) {
    if (error instanceof LearningCanvasAdminConflictError) throw error;
    return invalid();
  }
}

export async function disconnectCanvasConnection(
  db: AppDb,
  rawInput: CanvasAdminEnvironment & {
    readonly expectedRevision: number;
    readonly actorPersonId: number;
  },
): Promise<LearningConnectionRecord> {
  const input = environment({
    connectionId: rawInput.connectionId, allowedOrigins: rawInput.allowedOrigins, clientId: rawInput.clientId,
    clientSecret: rawInput.clientSecret, keyRing: rawInput.keyRing,
    fetcher: rawInput.fetcher, nowEpochMs: rawInput.nowEpochMs,
  });
  const expectedRevision = integer(rawInput.expectedRevision, 0);
  const actorPersonId = integer(rawInput.actorPersonId);
  const connection = (await getLearningConnection(db, input.connectionId, { includeDeleted: false })) ?? invalid();
  if (
    connection.provider !== 'canvas' || connection.revision !== expectedRevision
    || (connection.status !== 'active' && connection.status !== 'error')
  ) throw new LearningCanvasAdminConflictError();
  const loaded = await loadCanvasCredentialForAdmin(db, {
    connectionId: input.connectionId, keyRing: input.keyRing,
  });
  if (loaded.revision !== expectedRevision) throw new LearningCanvasAdminConflictError();
  requireAllowedCanvasOrigin(loaded.baseUrl, input.allowedOrigins);
  await revokeCanvasAccessToken({
    baseUrl: loaded.baseUrl,
    accessToken: loaded.credential.accessToken,
    fetcher: input.fetcher,
    signal: new AbortController().signal,
  });
  return disconnectLearningConnection(db, {
    connectionId: input.connectionId, expectedRevision, actorPersonId,
  });
}
