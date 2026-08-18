import type { AppDb, AppDbResult } from './appDb';
import { isValidDateStr } from './dates';
import {
  ACTIVITY_DIMENSIONS,
  ACTIVITY_MEMBERSHIP_STATUSES,
  ActivityScoreConfigurationError,
  validateActivityScoreConfig,
  type ActivityMembershipStatus,
  type ActivityScoreConfig,
} from './activityScoreModel';

export const MAX_ACTIVITY_SCORE_PEOPLE = 5_000;
export const MAX_ACTIVITY_SCORE_EVENTS = 5_000;

export class ActivityScoreConflictError extends Error {
  readonly code = 'activity_score_conflict' as const;
  constructor() {
    super('Activity score configuration changed');
    this.name = 'ActivityScoreConflictError';
  }
}

export class ActivityScorePersistenceError extends Error {
  readonly code = 'activity_score_persistence' as const;
  constructor() {
    super('Activity score persistence failed');
    this.name = 'ActivityScorePersistenceError';
  }
}

export class ActivityScoreLimitError extends Error {
  readonly code = 'activity_score_limit' as const;
  constructor() {
    super('Activity score population exceeds the supported limit');
    this.name = 'ActivityScoreLimitError';
  }
}

export interface EligibleActivityPerson {
  personId: number;
  name: string;
  membershipStatus: ActivityMembershipStatus;
}

export interface GroupAttendanceEvidenceRow {
  personId: number;
  present: number;
  opportunities: number;
}

export interface ActivityCountEvidenceRow {
  personId: number;
  count: number;
}

type DataRow = Record<string, unknown>;

function dataRow(value: unknown, fields: readonly string[]): DataRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) return null;
  const row: DataRow = Object.create(null) as DataRow;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !('value' in descriptor)) return null;
    row[field] = descriptor.value;
  }
  return row;
}

function dbInteger(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value) || value.length > 16) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function changes(result: AppDbResult<unknown> | undefined): number | null {
  return dbInteger(result?.meta?.changes);
}

function membershipStatus(value: unknown): ActivityMembershipStatus | null {
  return typeof value === 'string' && (ACTIVITY_MEMBERSHIP_STATUSES as readonly string[]).includes(value)
    ? value as ActivityMembershipStatus
    : null;
}

function persistenceError(): never {
  throw new ActivityScorePersistenceError();
}

export async function getActivityScoreConfig(db: AppDb): Promise<ActivityScoreConfig> {
  try {
    const statements = [
      db.prepare(`
        SELECT window_days, include_visitor, include_regular, include_member,
               include_inactive, active_threshold, watch_threshold, revision
        FROM activity_score_config WHERE id = 1
      `),
      db.prepare(`
        SELECT dimension_key, enabled, weight, target_count
        FROM activity_score_dimensions ORDER BY dimension_key
      `),
    ];
    const results = db.snapshotBatch
      ? await db.snapshotBatch(statements)
      : await db.batch(statements);
    if (!Array.isArray(results) || results.length !== 2) persistenceError();
    const configRows = results[0]?.results;
    const dimensionRows = results[1]?.results;
    if (!Array.isArray(configRows) || configRows.length !== 1 || !Array.isArray(dimensionRows) || dimensionRows.length !== ACTIVITY_DIMENSIONS.length) {
      persistenceError();
    }
    const configRow = dataRow(configRows[0], [
      'window_days', 'include_visitor', 'include_regular', 'include_member',
      'include_inactive', 'active_threshold', 'watch_threshold', 'revision',
    ]);
    if (!configRow) persistenceError();
    const includedStatuses: ActivityMembershipStatus[] = [];
    const flagPairs = [
      ['visitor', configRow.include_visitor],
      ['regular', configRow.include_regular],
      ['member', configRow.include_member],
      ['inactive', configRow.include_inactive],
    ] as const;
    for (const [status, raw] of flagPairs) {
      const flag = dbInteger(raw, 0, 1);
      if (flag === null) persistenceError();
      if (flag === 1) includedStatuses.push(status);
    }
    const dimensions = Object.create(null) as ActivityScoreConfig['dimensions'];
    for (const value of dimensionRows) {
      const row = dataRow(value, ['dimension_key', 'enabled', 'weight', 'target_count']);
      if (!row || typeof row.dimension_key !== 'string' || !(ACTIVITY_DIMENSIONS as readonly string[]).includes(row.dimension_key)) {
        persistenceError();
      }
      const key = row.dimension_key as keyof ActivityScoreConfig['dimensions'];
      if (Object.hasOwn(dimensions, key)) persistenceError();
      const enabled = dbInteger(row.enabled, 0, 1);
      const weight = dbInteger(row.weight, 0, 100);
      const targetCount = row.target_count === null ? null : dbInteger(row.target_count, 1, 100);
      if (enabled === null || weight === null || (row.target_count !== null && targetCount === null)) persistenceError();
      dimensions[key] = { enabled: enabled === 1, weight, targetCount };
    }
    return validateActivityScoreConfig({
      windowDays: dbInteger(configRow.window_days, 1, 180),
      includedStatuses,
      activeThreshold: dbInteger(configRow.active_threshold, 1, 100),
      watchThreshold: dbInteger(configRow.watch_threshold, 0, 99),
      revision: dbInteger(configRow.revision),
      dimensions,
    });
  } catch (error) {
    if (error instanceof ActivityScorePersistenceError) throw error;
    throw new ActivityScorePersistenceError();
  }
}

export async function saveActivityScoreConfig(
  db: AppDb,
  rawConfig: ActivityScoreConfig,
  expectedRevision: number,
  actorPersonId: number,
): Promise<ActivityScoreConfig> {
  const config = validateActivityScoreConfig(rawConfig);
  if (
    !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || config.revision !== expectedRevision
    || !Number.isSafeInteger(actorPersonId) || actorPersonId <= 0
  ) throw new ActivityScoreConfigurationError();
  const flags = new Set(config.includedStatuses);
  const mutationId = crypto.randomUUID();
  try {
    const statements = [
      db.prepare(`
        UPDATE activity_score_config SET
          window_days=?, include_visitor=?, include_regular=?, include_member=?, include_inactive=?,
          active_threshold=?, watch_threshold=?, revision=revision+1, last_mutation_id=?,
          updated_by_person_id=?, updated_at=datetime('now')
        WHERE id=1 AND revision=?
      `).bind(
        config.windowDays,
        flags.has('visitor') ? 1 : 0,
        flags.has('regular') ? 1 : 0,
        flags.has('member') ? 1 : 0,
        flags.has('inactive') ? 1 : 0,
        config.activeThreshold,
        config.watchThreshold,
        mutationId,
        actorPersonId,
        expectedRevision,
      ),
      ...ACTIVITY_DIMENSIONS.map((key) => {
        const dimension = config.dimensions[key];
        return db.prepare(`
          UPDATE activity_score_dimensions
          SET enabled=?, weight=?, target_count=?
          WHERE dimension_key=? AND EXISTS (
            SELECT 1 FROM activity_score_config
            WHERE id=1 AND revision=? AND last_mutation_id=?
          )
        `).bind(
          dimension.enabled ? 1 : 0,
          dimension.weight,
          dimension.targetCount,
          key,
          expectedRevision + 1,
          mutationId,
        );
      }),
    ];
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== ACTIVITY_DIMENSIONS.length + 1) persistenceError();
    if (changes(results[0]) === 0) throw new ActivityScoreConflictError();
    if (changes(results[0]) !== 1 || results.slice(1).some((result) => changes(result) !== 1)) persistenceError();
    const saved = await getActivityScoreConfig(db);
    if (saved.revision !== expectedRevision + 1) persistenceError();
    return saved;
  } catch (error) {
    if (error instanceof ActivityScoreConflictError || error instanceof ActivityScorePersistenceError) throw error;
    throw new ActivityScorePersistenceError();
  }
}

function validateStatuses(statuses: readonly ActivityMembershipStatus[]): ActivityMembershipStatus[] {
  if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > 4) throw new ActivityScoreConfigurationError();
  const captured: ActivityMembershipStatus[] = [];
  for (const status of statuses) {
    if (!(ACTIVITY_MEMBERSHIP_STATUSES as readonly string[]).includes(status) || captured.includes(status)) {
      throw new ActivityScoreConfigurationError();
    }
    captured.push(status);
  }
  return captured;
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_SCORE_PEOPLE) {
    throw new ActivityScoreConfigurationError();
  }
}

export async function listEligibleActivityPeople(
  db: AppDb,
  statuses: readonly ActivityMembershipStatus[],
  limit = MAX_ACTIVITY_SCORE_PEOPLE,
): Promise<EligibleActivityPerson[]> {
  const selected = validateStatuses(statuses);
  validateLimit(limit);
  try {
    const placeholders = selected.map(() => '?').join(',');
    const result = await db.prepare(`
      SELECT id, display_name, membership_status
      FROM people
      WHERE deleted_at IS NULL AND active=1 AND membership_status IN (${placeholders})
      ORDER BY id LIMIT ?
    `).bind(...selected, limit + 1).all<unknown>();
    if (!Array.isArray(result.results)) persistenceError();
    if (result.results.length > limit) throw new ActivityScoreLimitError();
    return result.results.map((value) => {
      const row = dataRow(value, ['id', 'display_name', 'membership_status']);
      const personId = row ? dbInteger(row.id, 1) : null;
      const status = row ? membershipStatus(row.membership_status) : null;
      if (!row || personId === null || typeof row.display_name !== 'string' || row.display_name.length < 1 || row.display_name.length > 2_000 || !status) {
        persistenceError();
      }
      return { personId, name: row.display_name, membershipStatus: status };
    });
  } catch (error) {
    if (error instanceof ActivityScoreLimitError || error instanceof ActivityScorePersistenceError) throw error;
    throw new ActivityScorePersistenceError();
  }
}

function validateWindow(from: string, to: string, limit: number): void {
  validateLimit(limit);
  if (!isValidDateStr(from) || !isValidDateStr(to) || from > to) throw new ActivityScoreConfigurationError();
}

function parseCountRows(results: unknown[], limit: number): ActivityCountEvidenceRow[] {
  if (results.length > limit) throw new ActivityScoreLimitError();
  const rows: ActivityCountEvidenceRow[] = [];
  for (const value of results) {
    const row = dataRow(value, ['person_id', 'activity_count']);
    const personId = row ? dbInteger(row.person_id, 1) : null;
    const count = row ? dbInteger(row.activity_count, 1) : null;
    if (personId === null || count === null || (rows.length > 0 && personId <= rows[rows.length - 1].personId)) persistenceError();
    rows.push({ personId, count });
  }
  return rows;
}

export async function listGroupAttendanceEvidence(
  db: AppDb,
  from: string,
  to: string,
  limit = MAX_ACTIVITY_SCORE_PEOPLE,
): Promise<GroupAttendanceEvidenceRow[]> {
  validateWindow(from, to, limit);
  try {
    const result = await db.prepare(`
      SELECT gm.person_id,
             SUM(CASE WHEN ga.present=1 THEN 1 ELSE 0 END) AS present_count,
             COUNT(*) AS opportunity_count
      FROM group_attendance ga
      JOIN group_members gm ON gm.id=ga.member_id
        AND gm.person_id IS NOT NULL AND gm.removed_at IS NULL
      JOIN group_event_occurrences geo ON geo.id=ga.occurrence_id
        AND geo.deleted_at IS NULL
      JOIN group_events ge ON ge.id=geo.event_id AND ge.deleted_at IS NULL
      WHERE geo.occurs_on >= ? AND geo.occurs_on <= ?
      GROUP BY gm.person_id
      ORDER BY gm.person_id LIMIT ?
    `).bind(from, to, limit + 1).all<unknown>();
    if (!Array.isArray(result.results)) persistenceError();
    if (result.results.length > limit) throw new ActivityScoreLimitError();
    const rows: GroupAttendanceEvidenceRow[] = [];
    for (const value of result.results) {
      const row = dataRow(value, ['person_id', 'present_count', 'opportunity_count']);
      const personId = row ? dbInteger(row.person_id, 1) : null;
      const present = row ? dbInteger(row.present_count, 0) : null;
      const opportunities = row ? dbInteger(row.opportunity_count, 1) : null;
      if (
        personId === null || present === null || opportunities === null || present > opportunities
        || (rows.length > 0 && personId <= rows[rows.length - 1].personId)
      ) persistenceError();
      rows.push({ personId, present, opportunities });
    }
    return rows;
  } catch (error) {
    if (error instanceof ActivityScoreLimitError || error instanceof ActivityScorePersistenceError) throw error;
    throw new ActivityScorePersistenceError();
  }
}

async function countEvidence(db: AppDb, sql: string, from: string, to: string, limit: number): Promise<ActivityCountEvidenceRow[]> {
  validateWindow(from, to, limit);
  try {
    const result = await db.prepare(sql).bind(from, to, limit + 1).all<unknown>();
    if (!Array.isArray(result.results)) persistenceError();
    return parseCountRows(result.results, limit);
  } catch (error) {
    if (error instanceof ActivityScoreLimitError || error instanceof ActivityScorePersistenceError) throw error;
    throw new ActivityScorePersistenceError();
  }
}

export function listServingEvidence(
  db: AppDb,
  from: string,
  to: string,
  limit = MAX_ACTIVITY_SCORE_PEOPLE,
): Promise<ActivityCountEvidenceRow[]> {
  return countEvidence(db, `
    SELECT ra.person_id, COUNT(*) AS activity_count
    FROM roster_assignments ra
    JOIN plans ON plans.id=ra.plan_id AND plans.deleted_at IS NULL
    WHERE ra.deleted_at IS NULL AND ra.status='C'
      AND plans.plan_date >= ? AND plans.plan_date <= ?
    GROUP BY ra.person_id
    ORDER BY ra.person_id LIMIT ?
  `, from, to, limit);
}

export function listRegistrationEvidence(
  db: AppDb,
  from: string,
  to: string,
  limit = MAX_ACTIVITY_SCORE_PEOPLE,
): Promise<ActivityCountEvidenceRow[]> {
  return countEvidence(db, `
    SELECT registrations.person_id, COUNT(*) AS activity_count
    FROM registrations
    JOIN reg_events ON reg_events.id=registrations.event_id
    WHERE registrations.person_id IS NOT NULL AND registrations.status='confirmed'
      AND substr(reg_events.starts_at, 1, 10) >= ?
      AND substr(reg_events.starts_at, 1, 10) <= ?
    GROUP BY registrations.person_id
    ORDER BY registrations.person_id LIMIT ?
  `, from, to, limit);
}

export async function isLearningActivitySourceAvailable(db: AppDb): Promise<boolean> {
  try {
    const value = await db.prepare(`
      SELECT 1 AS available
      FROM learning_provider_connections
      WHERE status='active' AND deleted_at IS NULL
      ORDER BY id LIMIT 1
    `).first<unknown>();
    if (value === null) return false;
    const row = dataRow(value, ['available']);
    if (!row || dbInteger(row.available, 1, 1) !== 1) persistenceError();
    return true;
  } catch (error) {
    if (error instanceof ActivityScorePersistenceError) throw error;
    throw new ActivityScorePersistenceError();
  }
}

function validateEventLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_SCORE_EVENTS) {
    throw new ActivityScoreConfigurationError();
  }
}

export async function listLearningEngagementEvidence(
  db: AppDb,
  from: string,
  to: string,
  personLimit = MAX_ACTIVITY_SCORE_PEOPLE,
  eventLimit = MAX_ACTIVITY_SCORE_EVENTS,
): Promise<ActivityCountEvidenceRow[]> {
  validateWindow(from, to, personLimit);
  validateEventLimit(eventLimit);
  try {
    const result = await db.prepare(`
      WITH bounded_events AS (
        SELECT DISTINCT event.id, event.person_id, event.occurred_at
        FROM learning_activity_events event
        JOIN people person ON person.id=event.person_id
          AND person.active=1 AND person.deleted_at IS NULL
        JOIN learning_provider_connections connection
          ON connection.id=event.connection_id
          AND connection.status='active' AND connection.deleted_at IS NULL
        JOIN learning_courses course
          ON course.id=event.course_id AND course.connection_id=event.connection_id
          AND course.deleted_at IS NULL AND course.lifecycle_state<>'deleted'
        JOIN learning_programs program ON program.id=course.program_id
          AND program.deleted_at IS NULL
        JOIN learning_identity_links identity_link
          ON identity_link.id=event.identity_link_id
          AND identity_link.connection_id=event.connection_id
          AND identity_link.person_id=event.person_id AND identity_link.status='active'
        JOIN learning_enrollments enrollment
          ON enrollment.id=event.enrollment_id AND enrollment.course_id=event.course_id
          AND enrollment.connection_id=event.connection_id
          AND enrollment.identity_link_id=event.identity_link_id
          AND enrollment.state IN ('active','completed')
        WHERE event.event_type IN ('assignment_submitted','quiz_submitted')
          AND substr(event.occurred_at,1,10) >= ?
          AND substr(event.occurred_at,1,10) <= ?
        ORDER BY event.occurred_at,event.person_id,event.id
        LIMIT ?
      ), person_counts AS (
        SELECT person_id, COUNT(*) AS activity_count
        FROM bounded_events GROUP BY person_id
      )
      SELECT person_id, activity_count,
        (SELECT COUNT(*) FROM bounded_events) AS total_event_count
      FROM person_counts ORDER BY person_id LIMIT ?
    `).bind(from, to, eventLimit + 1, personLimit + 1).all<unknown>();
    if (!Array.isArray(result.results)) persistenceError();
    if (result.results.length > personLimit) throw new ActivityScoreLimitError();
    const rows: ActivityCountEvidenceRow[] = [];
    let expectedTotal: number | null = null;
    for (const value of result.results) {
      const row = dataRow(value, ['person_id', 'activity_count', 'total_event_count']);
      const personId = row ? dbInteger(row.person_id, 1) : null;
      const count = row ? dbInteger(row.activity_count, 1, eventLimit + 1) : null;
      const total = row ? dbInteger(row.total_event_count, 1, eventLimit + 1) : null;
      if (
        personId === null || count === null || total === null || count > total
        || (expectedTotal !== null && total !== expectedTotal)
        || (rows.length > 0 && personId <= rows[rows.length - 1].personId)
      ) persistenceError();
      expectedTotal = total;
      rows.push({ personId, count });
    }
    if (expectedTotal !== null && expectedTotal > eventLimit) throw new ActivityScoreLimitError();
    return rows;
  } catch (error) {
    if (error instanceof ActivityScoreLimitError || error instanceof ActivityScorePersistenceError) throw error;
    throw new ActivityScorePersistenceError();
  }
}
