import type { AppDb, AppDbResult, AppStatement } from './appDb';
import {
  LearningGoogleAuthConflictError,
  loadGoogleCredential,
  refreshGoogleAccessToken,
  rotateGoogleCredential,
} from './learningGoogleAuth';
import type { LearningCredentialKeyRing } from './learningCredentials';
import type { LearningMappedCourseRecord } from './learningDb';
import {
  LEARNING_LIMITS,
  learningValidation,
  normalizeLearningConnectionUrlPolicy,
  normalizeLearningCourse,
  type LearningConnectionUrlPolicy,
  type LearningCourse,
} from './learningModel';
import {
  createGoogleClassroomRegistration,
  deleteGoogleClassroomRegistration,
  GOOGLE_CLASSROOM_FEED_TYPES,
  LearningGooglePubSubConflictError,
  listGoogleClassroomRegistrationsDue,
  saveGoogleClassroomRegistration,
  type GoogleClassroomRegistration,
} from './learningGooglePubSub';

const REFRESH_SKEW_MS = 5 * 60 * 1_000;
const MAPPING_CLAIM_MS = 2 * 60 * 1_000;
const RENEWAL_HORIZON_MS = 48 * 60 * 60 * 1_000;
// Twelve hourly replacements provide 2,016 feed slots per week, covering the
// supported 2,000 feeds while remaining below the D1 Free query budget.
const RENEWAL_LIMIT = 12;

type RegistrationFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class LearningGoogleRegistrationLifecycleError extends Error {
  readonly code = 'learning_google_registration_lifecycle_failed' as const;
  constructor() {
    super('learning_google_registration_lifecycle_failed');
    this.name = 'LearningGoogleRegistrationLifecycleError';
  }
}

export class LearningGoogleRegistrationLifecycleConflictError extends Error {
  readonly code = 'learning_google_registration_lifecycle_conflict' as const;
  constructor() {
    super('learning_google_registration_lifecycle_conflict');
    this.name = 'LearningGoogleRegistrationLifecycleConflictError';
  }
}

const invalid = (): never => { throw new LearningGoogleRegistrationLifecycleError(); };

function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = plain(value);
  const actual = Object.keys(row);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  return row;
}

function integer(value: unknown, minimum = 1): number {
  try { return learningValidation.integer(value, minimum, LEARNING_LIMITS.databaseInteger); } catch { return invalid(); }
}

function epoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function externalId(value: unknown): string {
  try { return learningValidation.externalId(value); } catch { return invalid(); }
}

function bounded(value: unknown, minimum: number, maximum: number): string {
  try { return learningValidation.boundedString(value, minimum, maximum); } catch { return invalid(); }
}

function uuid(): string {
  const value = crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) invalid();
  return value;
}

function resultRows(result: AppDbResult<unknown> | undefined, maximum: number): Record<string, unknown>[] {
  if (!result || !Array.isArray(result.results) || result.results.length > maximum) invalid();
  const safe = result ?? invalid();
  return safe.results.map(plain);
}

function affected(result: AppDbResult<unknown> | undefined): number {
  if (!result || !result.meta || !Number.isInteger(result.meta.changes) || result.meta.changes < 0) invalid();
  return (result ?? invalid()).meta.changes;
}

function topicName(value: unknown): string {
  const name = bounded(value, 20, 512);
  if (!/^projects\/[A-Za-z0-9._:-]+\/topics\/[A-Za-z0-9._~-]+$/u.test(name)) invalid();
  return name;
}

function subscriptionName(value: unknown): string {
  const name = bounded(value, 28, 512);
  if (!/^projects\/[A-Za-z0-9._:-]+\/subscriptions\/[A-Za-z0-9._~-]+$/u.test(name)) invalid();
  return name;
}

function serviceAccountEmail(value: unknown): string {
  const email = bounded(value, 6, 320);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/u.test(email)) {
    invalid();
  }
  return email;
}

export type GoogleClassroomPushReadiness =
  | { readonly mode: 'ready'; readonly topicName: string }
  | { readonly mode: 'polling_only' | 'misconfigured'; readonly topicName: null };

export function googleClassroomPushReadiness(rawInput: {
  readonly topicName: string | undefined;
  readonly subscriptionName: string | undefined;
  readonly serviceAccountEmail: string | undefined;
}): GoogleClassroomPushReadiness {
  let row: Record<string, unknown>;
  try { row = exact(rawInput, ['topicName', 'subscriptionName', 'serviceAccountEmail']); } catch {
    return Object.freeze({ mode: 'misconfigured', topicName: null });
  }
  const values = [row.topicName, row.subscriptionName, row.serviceAccountEmail];
  if (values.every((value) => value === undefined)) {
    return Object.freeze({ mode: 'polling_only', topicName: null });
  }
  if (!values.every((value) => typeof value === 'string')) {
    return Object.freeze({ mode: 'misconfigured', topicName: null });
  }
  try {
    const topic = topicName(row.topicName);
    subscriptionName(row.subscriptionName);
    serviceAccountEmail(row.serviceAccountEmail);
    return Object.freeze({
      mode: 'ready',
      // Parse every allowlist binding even though registration creation only
      // sends the topic. A partially deployable path is never shown as ready.
      topicName: topic,
    });
  } catch {
    return Object.freeze({ mode: 'misconfigured', topicName: null });
  }
}

export interface GoogleCourseMappingCommit {
  readonly mappedCourse: LearningMappedCourseRecord;
  readonly connectionRevision: number;
}

function normalizedRegistrations(
  value: unknown,
  externalCourseId: string,
): readonly GoogleClassroomRegistration[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const items = value as unknown[];
  if (items.length !== 0 && items.length !== GOOGLE_CLASSROOM_FEED_TYPES.length) invalid();
  const rows: GoogleClassroomRegistration[] = items.map((item: unknown) => {
    const row = exact(item, ['externalCourseId', 'feedType', 'registrationId', 'topicName', 'expiryTime']);
    const feedType = learningValidation.oneOf(row.feedType, GOOGLE_CLASSROOM_FEED_TYPES);
    const expiryTime = learningValidation.timestamp(row.expiryTime);
    return Object.freeze({
      externalCourseId: externalId(row.externalCourseId),
      feedType,
      registrationId: externalId(row.registrationId),
      topicName: topicName(row.topicName),
      expiryTime,
    });
  });
  if (
    rows.some((row) => row.externalCourseId !== externalCourseId)
    || new Set(rows.map((row) => row.feedType)).size !== rows.length
    || (rows.length === 2 && GOOGLE_CLASSROOM_FEED_TYPES.some((feed) => !rows.some((row) => row.feedType === feed)))
  ) invalid();
  return Object.freeze(rows);
}

function mappedCourse(row: Record<string, unknown>): LearningMappedCourseRecord {
  if (row.provider !== 'google_classroom' || row.lifecycle_state !== 'active') invalid();
  return Object.freeze({
    courseId: integer(row.course_id),
    programId: integer(row.program_id),
    connectionId: integer(row.connection_id),
    provider: 'google_classroom',
    externalCourseId: externalId(row.external_course_id),
    displayName: bounded(row.display_name, 1, LEARNING_LIMITS.courseDisplayNameBytes),
    lifecycleState: 'active',
    lastSyncedAt: row.last_synced_at === null ? null : learningValidation.timestamp(row.last_synced_at),
  });
}

function normalizedRegistrationIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 2) invalid();
  const ids = (value as unknown[]).map(externalId);
  if (new Set(ids).size !== ids.length) invalid();
  return Object.freeze(ids);
}

export async function loadGoogleClassroomCourseRegistrationIds(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly externalCourseId: string;
  },
): Promise<readonly string[]> {
  const input = exact(rawInput, ['connectionId', 'expectedRevision', 'externalCourseId']);
  const connectionId = integer(input.connectionId);
  const expectedRevision = integer(input.expectedRevision, 0);
  const courseId = externalId(input.externalCourseId);
  const result = await db.prepare(`SELECT registration_id FROM learning_google_registrations
    WHERE connection_id=?1 AND external_course_id=?2
      AND EXISTS (SELECT 1 FROM learning_provider_connections c
        WHERE c.id=?1 AND c.provider='google_classroom' AND c.status='active'
          AND c.revision=?3 AND c.deleted_at IS NULL AND c.operation_marker IS NULL)
    ORDER BY feed_type LIMIT 3`)
    .bind(connectionId, courseId, expectedRevision).all<Record<string, unknown>>();
  const rows = resultRows(result, 2);
  return Object.freeze(rows.map((row) => externalId(row.registration_id)));
}

export async function commitGoogleClassroomCourseMapping(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly programId: number;
    readonly actorPersonId: number;
    readonly course: LearningCourse;
    readonly urlPolicy: LearningConnectionUrlPolicy;
    readonly expectedRegistrationIds: readonly string[];
    readonly registrations: readonly GoogleClassroomRegistration[];
    readonly nowEpochMs: number;
  },
): Promise<GoogleCourseMappingCommit> {
  const input = exact(rawInput, [
    'connectionId', 'expectedRevision', 'programId', 'actorPersonId', 'course',
    'urlPolicy', 'expectedRegistrationIds', 'registrations', 'nowEpochMs',
  ]);
  const connectionId = integer(input.connectionId);
  const expectedRevision = integer(input.expectedRevision, 0);
  if (expectedRevision >= LEARNING_LIMITS.databaseInteger) invalid();
  const claimedRevision = expectedRevision + 1;
  const programId = integer(input.programId);
  const actorPersonId = integer(input.actorPersonId);
  const now = epoch(input.nowEpochMs);
  const policy = normalizeLearningConnectionUrlPolicy(input.urlPolicy);
  const course = normalizeLearningCourse(input.course, policy);
  if (course.connectionId !== connectionId || course.provider !== 'google_classroom') invalid();
  const registrations = normalizedRegistrations(input.registrations, course.externalCourseId);
  const expectedRegistrationIds = normalizedRegistrationIds(input.expectedRegistrationIds);
  if (registrations.some((registration) => Date.parse(registration.expiryTime) <= now)) invalid();
  const marker = uuid();
  const claimExpiresAt = new Date(now + MAPPING_CLAIM_MS).toISOString();
  const statements: AppStatement[] = [
    db.prepare(`UPDATE learning_provider_connections SET
      operation_marker=?1,operation_expires_at=?2,revision=revision+1,
      updated_by_person_id=?3,updated_at=datetime('now')
      WHERE id=?4 AND provider='google_classroom' AND status='active' AND revision=?5
        AND deleted_at IS NULL AND operation_marker IS NULL
        AND EXISTS (SELECT 1 FROM learning_programs p
          WHERE p.id=?6 AND p.status='active' AND p.deleted_at IS NULL)
        AND (SELECT COUNT(*) FROM learning_google_registrations r
          WHERE r.connection_id=?4 AND r.external_course_id=?7)=?8
        AND (SELECT COUNT(*) FROM learning_google_registrations r
          WHERE r.connection_id=?4 AND r.external_course_id=?7
            AND r.registration_id IN (?9,?10))=?8`)
      .bind(
        marker, claimExpiresAt, actorPersonId, connectionId, expectedRevision, programId,
        course.externalCourseId, expectedRegistrationIds.length,
        expectedRegistrationIds[0] ?? null, expectedRegistrationIds[1] ?? null,
      ),
    db.prepare(`INSERT INTO learning_courses
      (program_id,connection_id,provider,external_course_id,display_name,launch_url,lifecycle_state,
       provider_updated_at,last_synced_at,created_at,updated_at,deleted_at)
      SELECT ?1,c.id,'google_classroom',?2,?3,?4,'active',?5,?6,datetime('now'),datetime('now'),NULL
      FROM learning_provider_connections c
      WHERE c.id=?7 AND c.revision=?8 AND c.operation_marker=?9
      ON CONFLICT(connection_id,external_course_id) DO UPDATE SET
        program_id=excluded.program_id,display_name=excluded.display_name,launch_url=excluded.launch_url,
        lifecycle_state='active',provider_updated_at=excluded.provider_updated_at,
        last_synced_at=excluded.last_synced_at,updated_at=datetime('now'),deleted_at=NULL
      RETURNING id AS course_id,program_id,connection_id,provider,external_course_id,
        display_name,lifecycle_state,last_synced_at`)
      .bind(
        programId, course.externalCourseId, course.displayName, course.launchUrl,
        course.providerUpdatedAt, course.lastSyncedAt, connectionId, claimedRevision, marker,
      ),
    db.prepare(`DELETE FROM learning_google_registrations WHERE connection_id=?1 AND external_course_id=?2
      AND EXISTS (SELECT 1 FROM learning_provider_connections c
        WHERE c.id=?1 AND c.revision=?3 AND c.operation_marker=?4)`)
      .bind(connectionId, course.externalCourseId, claimedRevision, marker),
  ];
  for (const registration of registrations) {
    statements.push(db.prepare(`INSERT INTO learning_google_registrations
      (connection_id,external_course_id,feed_type,registration_id,topic_name,expiry_time,updated_at)
      SELECT c.id,?1,?2,?3,?4,?5,datetime('now') FROM learning_provider_connections c
      JOIN learning_courses lc ON lc.connection_id=c.id AND lc.external_course_id=?1
      WHERE c.id=?6 AND c.revision=?7 AND c.operation_marker=?8
        AND lc.provider='google_classroom' AND lc.lifecycle_state='active' AND lc.deleted_at IS NULL`)
      .bind(
        registration.externalCourseId, registration.feedType, registration.registrationId,
        registration.topicName, registration.expiryTime, connectionId, claimedRevision, marker,
      ));
  }
  statements.push(db.prepare(`UPDATE learning_provider_connections SET
    operation_marker=NULL,operation_expires_at=NULL,updated_by_person_id=?1,updated_at=datetime('now')
    WHERE id=?2 AND revision=?3 AND operation_marker=?4
      AND EXISTS (SELECT 1 FROM learning_courses lc
        WHERE lc.connection_id=?2 AND lc.external_course_id=?5 AND lc.program_id=?6
          AND lc.lifecycle_state='active' AND lc.deleted_at IS NULL)
      AND (SELECT COUNT(*) FROM learning_google_registrations r
        WHERE r.connection_id=?2 AND r.external_course_id=?5)=?7
    RETURNING id AS connection_id,revision`)
    .bind(
      actorPersonId, connectionId, claimedRevision, marker, course.externalCourseId,
      programId, registrations.length,
    ));
  try {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length) invalid();
    if (affected(results[0]) !== 1) throw new LearningGoogleRegistrationLifecycleConflictError();
    const courseRows = resultRows(results[1], 1);
    const finalRows = resultRows(results.at(-1), 1);
    if (courseRows.length !== 1 || finalRows.length !== 1) throw new LearningGoogleRegistrationLifecycleConflictError();
    if (integer(finalRows[0].connection_id) !== connectionId || integer(finalRows[0].revision) !== claimedRevision) invalid();
    return Object.freeze({
      mappedCourse: mappedCourse(courseRows[0]),
      connectionRevision: claimedRevision,
    });
  } catch (error) {
    if (
      error instanceof LearningGoogleRegistrationLifecycleError
      || error instanceof LearningGoogleRegistrationLifecycleConflictError
    ) throw error;
    throw new LearningGoogleRegistrationLifecycleConflictError();
  }
}

export interface GoogleCourseUnmapCommit {
  readonly connectionId: number;
  readonly connectionRevision: number;
}

export async function commitGoogleClassroomCourseUnmap(
  db: AppDb,
  rawInput: {
    readonly connectionId: number;
    readonly expectedRevision: number;
    readonly actorPersonId: number;
    readonly externalCourseId: string;
    readonly expectedRegistrationIds: readonly string[];
    readonly nowEpochMs: number;
  },
): Promise<GoogleCourseUnmapCommit> {
  const input = exact(rawInput, [
    'connectionId', 'expectedRevision', 'actorPersonId', 'externalCourseId',
    'expectedRegistrationIds', 'nowEpochMs',
  ]);
  const connectionId = integer(input.connectionId);
  const expectedRevision = integer(input.expectedRevision, 0);
  if (expectedRevision >= LEARNING_LIMITS.databaseInteger) invalid();
  const claimedRevision = expectedRevision + 1;
  const actor = integer(input.actorPersonId);
  const courseId = externalId(input.externalCourseId);
  const expectedRegistrationIds = normalizedRegistrationIds(input.expectedRegistrationIds);
  const now = epoch(input.nowEpochMs);
  const marker = uuid();
  try {
    const results = await db.batch([
      db.prepare(`UPDATE learning_provider_connections SET
        operation_marker=?1,operation_expires_at=?2,revision=revision+1,
        updated_by_person_id=?3,updated_at=datetime('now')
        WHERE id=?4 AND provider='google_classroom' AND status='active' AND revision=?5
          AND deleted_at IS NULL AND operation_marker IS NULL
          AND EXISTS (SELECT 1 FROM learning_courses lc
            WHERE lc.connection_id=?4 AND lc.external_course_id=?6
              AND lc.lifecycle_state='active' AND lc.deleted_at IS NULL)
          AND (SELECT COUNT(*) FROM learning_google_registrations r
            WHERE r.connection_id=?4 AND r.external_course_id=?6)=?7
          AND (SELECT COUNT(*) FROM learning_google_registrations r
            WHERE r.connection_id=?4 AND r.external_course_id=?6
              AND r.registration_id IN (?8,?9))=?7`)
        .bind(
          marker, new Date(now + MAPPING_CLAIM_MS).toISOString(), actor,
          connectionId, expectedRevision, courseId, expectedRegistrationIds.length,
          expectedRegistrationIds[0] ?? null, expectedRegistrationIds[1] ?? null,
        ),
      db.prepare(`DELETE FROM learning_google_registrations WHERE connection_id=?1 AND external_course_id=?2
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?3 AND c.operation_marker=?4)`)
        .bind(connectionId, courseId, claimedRevision, marker),
      db.prepare(`UPDATE learning_courses SET lifecycle_state='deleted',deleted_at=datetime('now'),
        updated_at=datetime('now') WHERE connection_id=?1 AND external_course_id=?2
        AND EXISTS (SELECT 1 FROM learning_provider_connections c
          WHERE c.id=?1 AND c.revision=?3 AND c.operation_marker=?4)`)
        .bind(connectionId, courseId, claimedRevision, marker),
      db.prepare(`UPDATE learning_provider_connections SET operation_marker=NULL,operation_expires_at=NULL,
        updated_by_person_id=?1,updated_at=datetime('now')
        WHERE id=?2 AND revision=?3 AND operation_marker=?4
          AND EXISTS (SELECT 1 FROM learning_courses lc
            WHERE lc.connection_id=?2 AND lc.external_course_id=?5
              AND lc.lifecycle_state='deleted' AND lc.deleted_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM learning_google_registrations r
            WHERE r.connection_id=?2 AND r.external_course_id=?5)
        RETURNING id AS connection_id,revision`)
        .bind(actor, connectionId, claimedRevision, marker, courseId),
    ]);
    if (!Array.isArray(results) || results.length !== 4) invalid();
    if (affected(results[0]) !== 1) throw new LearningGoogleRegistrationLifecycleConflictError();
    const rows = resultRows(results[3], 1);
    if (rows.length !== 1 || integer(rows[0].revision) !== claimedRevision) {
      throw new LearningGoogleRegistrationLifecycleConflictError();
    }
    return Object.freeze({
      connectionId,
      connectionRevision: claimedRevision,
    });
  } catch (error) {
    if (
      error instanceof LearningGoogleRegistrationLifecycleError
      || error instanceof LearningGoogleRegistrationLifecycleConflictError
    ) throw error;
    throw new LearningGoogleRegistrationLifecycleConflictError();
  }
}

async function activeAccessToken(
  db: AppDb,
  input: {
    readonly connectionId: number;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: RegistrationFetcher;
    readonly signal: AbortSignal;
    readonly nowEpochMs: number;
  },
): Promise<string> {
  let loaded = await loadGoogleCredential(db, { connectionId: input.connectionId, keyRing: input.keyRing });
  if (Date.parse(loaded.credential.accessTokenExpiresAt) > input.nowEpochMs + REFRESH_SKEW_MS) {
    return loaded.credential.accessToken;
  }
  const credential = await refreshGoogleAccessToken({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken: loaded.credential.refreshToken,
    refreshTokenExpiresAt: loaded.credential.refreshTokenExpiresAt,
    fetcher: input.fetcher,
    signal: input.signal,
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

export interface GoogleRegistrationRenewalSummary {
  readonly selected: number;
  readonly renewed: number;
  readonly conflicted: number;
  readonly failed: number;
}

export async function renewGoogleClassroomRegistrations(
  db: AppDb,
  rawInput: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly keyRing: LearningCredentialKeyRing;
    readonly fetcher: RegistrationFetcher;
    readonly nowEpochMs: number;
    readonly topicName: string;
    readonly signal: AbortSignal;
  },
): Promise<GoogleRegistrationRenewalSummary> {
  const input = exact(rawInput, [
    'clientId', 'clientSecret', 'keyRing', 'fetcher', 'nowEpochMs', 'topicName', 'signal',
  ]);
  if (typeof input.fetcher !== 'function' || !(input.signal instanceof AbortSignal) || input.signal.aborted) invalid();
  const clientId = bounded(input.clientId, 1, 512);
  const clientSecret = bounded(input.clientSecret, 1, 2_048);
  const currentTopicName = topicName(input.topicName);
  const now = epoch(input.nowEpochMs);
  const nowTimestamp = new Date(now).toISOString();
  const due = await listGoogleClassroomRegistrationsDue(db, {
    now: nowTimestamp,
    renewalHorizon: new Date(now + RENEWAL_HORIZON_MS).toISOString(),
    topicName: currentTopicName,
    limit: RENEWAL_LIMIT,
  });
  let renewed = 0;
  let conflicted = 0;
  let failed = 0;
  const accessTokens = new Map<number, string>();
  for (const stored of due) {
    if ((input.signal as AbortSignal).aborted) {
      failed += 1;
      continue;
    }
    let replacement: GoogleClassroomRegistration | null = null;
    try {
      let token = accessTokens.get(stored.connectionId);
      if (token === undefined) {
        token = await activeAccessToken(db, {
          connectionId: stored.connectionId,
          clientId,
          clientSecret,
          keyRing: input.keyRing as LearningCredentialKeyRing,
          fetcher: input.fetcher as RegistrationFetcher,
          signal: input.signal as AbortSignal,
          nowEpochMs: now,
        });
        accessTokens.set(stored.connectionId, token);
      }
      replacement = await createGoogleClassroomRegistration({
        accessToken: token,
        externalCourseId: stored.externalCourseId,
        feedType: stored.feedType,
        topicName: currentTopicName,
        fetcher: input.fetcher as RegistrationFetcher,
        signal: input.signal as AbortSignal,
        nowEpochMs: now,
      });
      await saveGoogleClassroomRegistration(db, {
        connectionId: stored.connectionId,
        expectedRegistrationId: stored.registrationId,
        registration: replacement,
        now: nowTimestamp,
      });
      renewed += 1;
      try {
        await deleteGoogleClassroomRegistration({
          accessToken: token,
          registrationId: stored.registrationId,
          fetcher: input.fetcher as RegistrationFetcher,
          signal: input.signal as AbortSignal,
        });
      } catch {
        // The old ID is no longer accepted by our push route and expires within
        // the provider's bounded registration lifetime. Keep the CAS winner.
      }
    } catch (error) {
      if (replacement !== null) {
        try {
          const token = accessTokens.get(stored.connectionId);
          if (token !== undefined) await deleteGoogleClassroomRegistration({
            accessToken: token,
            registrationId: replacement.registrationId,
            fetcher: input.fetcher as RegistrationFetcher,
            signal: input.signal as AbortSignal,
          });
        } catch { /* the replacement expires within the provider bound */ }
      }
      if (error instanceof LearningGooglePubSubConflictError) conflicted += 1;
      else failed += 1;
    }
  }
  return Object.freeze({ selected: due.length, renewed, conflicted, failed });
}
