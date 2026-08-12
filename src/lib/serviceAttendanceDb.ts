import type { AppDb } from './appDb';
import { isValidDateStr } from './dates';
import type { Locale } from './locales';
import { SERVICE_ATTENDANCE_LIMITS, type AdultCountInput, type AttendanceWindow } from './serviceAttendanceForms';

export const MAX_SERVICE_ATTENDANCE_REPORT_ROWS = 5_000;

export class ServiceAttendanceInvalidError extends Error {
  readonly code = 'attendance_invalid' as const;
  constructor() {
    super('Service attendance input is invalid');
    this.name = 'ServiceAttendanceInvalidError';
  }
}

export class ServiceAttendanceConflictError extends Error {
  readonly code = 'attendance_conflict' as const;
  constructor() {
    super('Service attendance conflicts with current data');
    this.name = 'ServiceAttendanceConflictError';
  }
}

export class ServiceAttendancePersistenceError extends Error {
  readonly code = 'attendance_failed' as const;
  constructor() {
    super('Service attendance persistence failed');
    this.name = 'ServiceAttendancePersistenceError';
  }
}

export class ServiceAttendanceReportLimitError extends Error {
  readonly code = 'attendance_report_limit' as const;
  constructor() {
    super('Service attendance report is too large');
    this.name = 'ServiceAttendanceReportLimitError';
  }
}

export interface ServiceAttendanceRow {
  serviceTypeId: number;
  attendanceDate: string;
  adultCount: number;
  recordedByPersonId: number;
  updatedByPersonId: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceCheckinLinkSnapshot {
  revision: number;
  eventIds: number[];
}

export interface ServiceCheckinLinkReplaceResult extends ServiceCheckinLinkSnapshot {
  changed: boolean;
}

export interface CurrentServiceCheckinLink {
  serviceTypeId: number;
  eventId: number;
}

export interface ServiceAttendanceReportRow {
  serviceTypeId: number;
  serviceName: string;
  serviceSort: number;
  attendanceDate: string;
  adultCount: number;
  childCount: number | null;
  combinedCount: number | null;
}

type DbDataRow = Record<string, unknown>;

const MAX_SERVICE_NAME_CODE_POINTS = 1_000;
const SQL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

function plainDataRow(value: unknown, fields: readonly string[]): DbDataRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) return null;
  const snapshot: DbDataRow = Object.create(null) as DbDataRow;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !('value' in descriptor)) return null;
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function plainDataFields(value: unknown, fields: readonly string[]): DbDataRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => {
    const descriptor = descriptors[key as keyof typeof descriptors];
    return !descriptor || !('value' in descriptor);
  })) return null;
  const snapshot: DbDataRow = Object.create(null) as DbDataRow;
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !('value' in descriptor)) return null;
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function plainResult(value: unknown): { results: unknown[]; changes: number } | null {
  const wrapper = plainDataFields(value, ['results', 'meta']);
  if (!wrapper || !Array.isArray(wrapper.results)) return null;
  const meta = plainDataFields(wrapper.meta, ['changes']);
  if (!meta) return null;
  const changes = meta.changes;
  return typeof changes !== 'number' || !Number.isSafeInteger(changes) || changes < 0
    ? null : { results: wrapper.results, changes };
}

function safeInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (
    typeof value !== 'string'
    || value.length > 16
    || !/^(?:0|-?[1-9]\d*)$/.test(value)
  ) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

function positiveId(value: unknown): number | null {
  const parsed = safeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function sqlTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = SQL_TIMESTAMP.exec(value);
  return match && isValidDateStr(match[1]) ? value : null;
}

function validPositiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateAdultInput(input: AdultCountInput, actorPersonId: number): void {
  if (
    !validPositiveId(input.serviceTypeId)
    || !isValidDateStr(input.attendanceDate)
    || !Number.isSafeInteger(input.adultCount)
    || input.adultCount < 0
    || input.adultCount > SERVICE_ATTENDANCE_LIMITS.maxAdultCount
    || !validPositiveId(actorPersonId)
  ) throw new ServiceAttendanceInvalidError();
}

function adultRow(value: unknown): ServiceAttendanceRow {
  const row = plainDataRow(value, [
    'service_type_id', 'attendance_date', 'adult_count', 'recorded_by_person_id',
    'updated_by_person_id', 'created_at', 'updated_at',
  ]);
  if (!row) throw new ServiceAttendancePersistenceError();
  const serviceTypeId = positiveId(row.service_type_id);
  const attendanceDate = typeof row.attendance_date === 'string' && isValidDateStr(row.attendance_date)
    ? row.attendance_date : null;
  const adultCount = safeInteger(row.adult_count);
  const recordedByPersonId = positiveId(row.recorded_by_person_id);
  const updatedByPersonId = positiveId(row.updated_by_person_id);
  const createdAt = sqlTimestamp(row.created_at);
  const updatedAt = sqlTimestamp(row.updated_at);
  if (
    serviceTypeId === null || attendanceDate === null
    || adultCount === null || adultCount < 0 || adultCount > SERVICE_ATTENDANCE_LIMITS.maxAdultCount
    || recordedByPersonId === null || updatedByPersonId === null
    || createdAt === null || updatedAt === null
  ) throw new ServiceAttendancePersistenceError();
  return {
    serviceTypeId,
    attendanceDate,
    adultCount,
    recordedByPersonId,
    updatedByPersonId,
    createdAt,
    updatedAt,
  };
}

export async function upsertServiceAttendance(
  db: AppDb,
  input: AdultCountInput,
  actorPersonId: number,
): Promise<ServiceAttendanceRow> {
  validateAdultInput(input, actorPersonId);
  try {
    const row = await db.prepare(`
      INSERT INTO service_attendance
        (service_type_id, attendance_date, adult_count,
         recorded_by_person_id, updated_by_person_id)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(service_type_id, attendance_date) DO UPDATE SET
        adult_count = excluded.adult_count,
        updated_by_person_id = excluded.updated_by_person_id,
        updated_at = datetime('now')
      RETURNING service_type_id, attendance_date, adult_count,
        recorded_by_person_id, updated_by_person_id, created_at, updated_at
    `).bind(
      input.serviceTypeId,
      input.attendanceDate,
      input.adultCount,
      actorPersonId,
    ).first<unknown>();
    if (row === null) throw new ServiceAttendancePersistenceError();
    return adultRow(row);
  } catch (error) {
    if (error instanceof ServiceAttendancePersistenceError) throw error;
    throw new ServiceAttendancePersistenceError();
  }
}

function validateLinkInput(serviceTypeId: number, eventIds: readonly number[], today: string, actorPersonId: number): number[] {
  if (
    !validPositiveId(serviceTypeId)
    || !isValidDateStr(today)
    || !validPositiveId(actorPersonId)
    || !Array.isArray(eventIds)
  ) throw new ServiceAttendanceInvalidError();
  const length = eventIds.length;
  if (
    !Number.isSafeInteger(length)
    || length < 0
    || length > SERVICE_ATTENDANCE_LIMITS.maxCheckinEvents
  ) throw new ServiceAttendanceInvalidError();
  const captured: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const eventId = eventIds[index];
    if (!validPositiveId(eventId)) throw new ServiceAttendanceInvalidError();
    captured.push(eventId);
  }
  return [...new Set(captured)].sort((left, right) => left - right);
}

function isLinkConflict(error: unknown): boolean {
  try {
    const code = typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
    const text = String(error);
    return code === '23503'
      || code === '23505'
      || text.includes('FOREIGN KEY constraint failed')
      || text.includes('UNIQUE constraint failed')
      || text.includes('service_attendance_link_conflict');
  } catch {
    return false;
  }
}

const OPEN_LINKS_SQL = `
  SELECT checkin_event_id
  FROM service_type_checkin_events
  WHERE service_type_id = ? AND ends_on IS NULL
  ORDER BY checkin_event_id
  LIMIT 101
`;

export async function listCurrentServiceCheckinLinks(db: AppDb): Promise<CurrentServiceCheckinLink[]> {
  try {
    const queryResult = await db.prepare(`
      SELECT service_type_id, checkin_event_id
      FROM service_type_checkin_events
      WHERE ends_on IS NULL
      ORDER BY service_type_id, checkin_event_id
      LIMIT 5001
    `).all<unknown>();
    const results = queryResult.results;
    if (!Array.isArray(results)) throw new ServiceAttendancePersistenceError();
    const length = results.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SERVICE_ATTENDANCE_REPORT_ROWS) {
      throw new ServiceAttendancePersistenceError();
    }
    const links: CurrentServiceCheckinLink[] = [];
    for (let index = 0; index < length; index += 1) {
      const row = plainDataRow(results[index], ['service_type_id', 'checkin_event_id']);
      const serviceTypeId = row ? positiveId(row.service_type_id) : null;
      const eventId = row ? positiveId(row.checkin_event_id) : null;
      const previous = links[index - 1];
      if (
        serviceTypeId === null
        || eventId === null
        || (previous && (
          serviceTypeId < previous.serviceTypeId
          || (serviceTypeId === previous.serviceTypeId && eventId <= previous.eventId)
        ))
      ) throw new ServiceAttendancePersistenceError();
      links.push({ serviceTypeId, eventId });
    }
    return links;
  } catch (error) {
    if (error instanceof ServiceAttendancePersistenceError) throw error;
    throw new ServiceAttendancePersistenceError();
  }
}

async function readLinkSnapshot(db: AppDb, serviceTypeId: number): Promise<ServiceCheckinLinkSnapshot> {
  await db.prepare(`
    INSERT INTO service_checkin_link_state (service_type_id, revision, last_mutation_id)
    VALUES (?, 0, '') ON CONFLICT(service_type_id) DO NOTHING
  `).bind(serviceTypeId).run();
  const statements = [
    db.prepare('SELECT revision FROM service_checkin_link_state WHERE service_type_id = ?').bind(serviceTypeId),
    db.prepare(OPEN_LINKS_SQL).bind(serviceTypeId),
  ];
  const results = db.snapshotBatch
    ? await db.snapshotBatch(statements)
    : await db.batch(statements);
  if (!Array.isArray(results)) throw new ServiceAttendancePersistenceError();
  const resultsLength = results.length;
  if (resultsLength !== 2) throw new ServiceAttendancePersistenceError();
  const revisionResult = plainResult(results[0]);
  const eventResult = plainResult(results[1]);
  if (!revisionResult || !eventResult) {
    throw new ServiceAttendancePersistenceError();
  }
  const revisionRows = revisionResult.results;
  const eventRows = eventResult.results;
  const revisionLength = revisionRows.length;
  const eventLength = eventRows.length;
  if (
    revisionLength !== 1
    || !Number.isSafeInteger(eventLength)
    || eventLength < 0
    || eventLength > SERVICE_ATTENDANCE_LIMITS.maxCheckinEvents
  ) throw new ServiceAttendancePersistenceError();
  const revisionRow = plainDataRow(revisionRows[0], ['revision']);
  const revision = revisionRow ? safeInteger(revisionRow.revision) : null;
  if (revision === null || revision < 0) throw new ServiceAttendancePersistenceError();
  const eventIds: number[] = [];
  for (let index = 0; index < eventLength; index += 1) {
    const eventRow = plainDataRow(eventRows[index], ['checkin_event_id']);
    const eventId = eventRow ? positiveId(eventRow.checkin_event_id) : null;
    if (eventId === null || (index > 0 && eventId <= eventIds[index - 1])) {
      throw new ServiceAttendancePersistenceError();
    }
    eventIds.push(eventId);
  }
  return { revision, eventIds };
}

export async function getServiceCheckinLinkSnapshot(
  db: AppDb,
  serviceTypeId: number,
): Promise<ServiceCheckinLinkSnapshot> {
  if (!validPositiveId(serviceTypeId)) throw new ServiceAttendanceInvalidError();
  try {
    return await readLinkSnapshot(db, serviceTypeId);
  } catch (error) {
    if (error instanceof ServiceAttendanceInvalidError || error instanceof ServiceAttendancePersistenceError) throw error;
    if (isLinkConflict(error)) throw new ServiceAttendanceConflictError();
    throw new ServiceAttendancePersistenceError();
  }
}

function validCasBatch(results: unknown, expectedRevision: number, statementCount: number): boolean {
  if (!Array.isArray(results)) return false;
  const resultLength = results.length;
  if (resultLength !== statementCount) return false;
  const cas = plainResult(results[0]);
  if (!cas || cas.changes !== 1) return false;
  const casLength = cas.results.length;
  if (casLength !== 1) return false;
  const revisionRow = plainDataRow(cas.results[0], ['revision']);
  const revision = revisionRow ? safeInteger(revisionRow.revision) : null;
  if (revision !== expectedRevision) return false;
  for (let index = 1; index < resultLength; index += 1) {
    const statementResult = plainResult(results[index]);
    if (!statementResult || statementResult.results.length !== 0 || statementResult.changes !== 1) return false;
  }
  return true;
}

export async function replaceServiceCheckinLinksToday(
  db: AppDb,
  serviceTypeId: number,
  eventIds: readonly number[],
  today: string,
  actorPersonId: number,
): Promise<ServiceCheckinLinkReplaceResult> {
  const target = validateLinkInput(serviceTypeId, eventIds, today, actorPersonId);
  try {
    const snapshot = await readLinkSnapshot(db, serviceTypeId);
    const current = new Set(snapshot.eventIds);
    const wanted = new Set(target);
    const removed = snapshot.eventIds.filter((id) => !wanted.has(id));
    const added = target.filter((id) => !current.has(id));
    const changed = removed.length > 0 || added.length > 0;

    const mutationId = crypto.randomUUID();
    const statements = [
      db.prepare(`
        UPDATE service_checkin_link_state
        SET revision = revision + 1, last_mutation_id = ?1
        WHERE service_type_id = ?2 AND revision = ?3
        RETURNING revision
      `).bind(mutationId, serviceTypeId, snapshot.revision),
      ...removed.map((eventId) => db.prepare(`
        UPDATE service_type_checkin_events
        SET ends_on = ?1, closed_by_person_id = ?2, closed_at = datetime('now')
        WHERE service_type_id = ?3 AND checkin_event_id = ?4 AND ends_on IS NULL
          AND EXISTS (
            SELECT 1 FROM service_checkin_link_state state
            WHERE state.service_type_id = ?3 AND state.last_mutation_id = ?5
          )
      `).bind(today, actorPersonId, serviceTypeId, eventId, mutationId)),
      ...added.map((eventId) => db.prepare(`
        INSERT INTO service_type_checkin_events
          (service_type_id, checkin_event_id, starts_on, created_by_person_id)
        SELECT ?1, ?2, ?3, ?4
        FROM service_checkin_link_state state
        WHERE state.service_type_id = ?1 AND state.last_mutation_id = ?5
      `).bind(serviceTypeId, eventId, today, actorPersonId, mutationId)),
    ];
    const results = await db.batch(statements);
    if (!validCasBatch(results, snapshot.revision + 1, statements.length)) {
      const cas = Array.isArray(results) ? plainResult(results[0]) : null;
      if (cas && cas.changes === 0 && cas.results.length === 0) {
        throw new ServiceAttendanceConflictError();
      }
      throw new ServiceAttendancePersistenceError();
    }
    return { revision: snapshot.revision + 1, eventIds: target, changed };
  } catch (error) {
    if (
      error instanceof ServiceAttendanceInvalidError
      || error instanceof ServiceAttendanceConflictError
      || error instanceof ServiceAttendancePersistenceError
    ) throw error;
    if (isLinkConflict(error)) throw new ServiceAttendanceConflictError();
    throw new ServiceAttendancePersistenceError();
  }
}

function windowDays(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function validateWindow(window: AttendanceWindow): void {
  if (
    !isValidDateStr(window.from)
    || !isValidDateStr(window.to)
    || window.from > window.to
    || windowDays(window.from, window.to) > SERVICE_ATTENDANCE_LIMITS.maxWindowDays
  ) throw new ServiceAttendanceInvalidError();
}

export async function listServiceAttendanceReport(
  db: AppDb,
  locale: Locale,
  window: Pick<AttendanceWindow, 'from' | 'to'>,
): Promise<ServiceAttendanceReportRow[]> {
  if (locale !== 'en' && locale !== 'zh') throw new ServiceAttendanceInvalidError();
  validateWindow({ ...window, days: 0 });
  try {
    const queryResult = await db.prepare(`
      SELECT
        sa.service_type_id,
        COALESCE(st_l.name, st_d.name, '') AS service_name,
        st.sort AS service_sort,
        sa.attendance_date,
        sa.adult_count,
        CASE WHEN EXISTS (
          SELECT 1
          FROM service_type_checkin_events configured
          WHERE configured.service_type_id = sa.service_type_id
            AND configured.starts_on <= sa.attendance_date
            AND (configured.ends_on IS NULL OR sa.attendance_date < configured.ends_on)
        ) THEN (
          SELECT COUNT(DISTINCT checkin.household_member_id)
          FROM service_type_checkin_events linked
          LEFT JOIN checkins checkin
            ON checkin.event_id = linked.checkin_event_id
           AND checkin.checkin_date = sa.attendance_date
          WHERE linked.service_type_id = sa.service_type_id
            AND linked.starts_on <= sa.attendance_date
            AND (linked.ends_on IS NULL OR sa.attendance_date < linked.ends_on)
        ) ELSE NULL END AS child_count
      FROM service_attendance sa
      JOIN service_types st ON st.id = sa.service_type_id
      LEFT JOIN service_type_i18n st_l
        ON st_l.service_type_id = st.id AND st_l.locale = ?1
      LEFT JOIN service_type_i18n st_d
        ON st_d.service_type_id = st.id AND st_d.locale = 'en'
      WHERE sa.attendance_date >= ?2 AND sa.attendance_date <= ?3
      ORDER BY sa.attendance_date DESC, st.sort, st.id
      LIMIT 5001
    `).bind(locale, window.from, window.to).all<unknown>();
    const results = queryResult.results;
    if (!Array.isArray(results)) throw new ServiceAttendancePersistenceError();
    const resultLength = results.length;
    if (!Number.isSafeInteger(resultLength) || resultLength < 0) {
      throw new ServiceAttendancePersistenceError();
    }
    if (resultLength > MAX_SERVICE_ATTENDANCE_REPORT_ROWS) {
      throw new ServiceAttendanceReportLimitError();
    }
    const report: ServiceAttendanceReportRow[] = [];
    for (let index = 0; index < resultLength; index += 1) {
      const row = plainDataRow(results[index], [
        'service_type_id', 'service_name', 'service_sort', 'attendance_date',
        'adult_count', 'child_count',
      ]);
      if (!row) throw new ServiceAttendancePersistenceError();
      const serviceTypeId = positiveId(row.service_type_id);
      const serviceName = typeof row.service_name === 'string'
        && Array.from(row.service_name).length <= MAX_SERVICE_NAME_CODE_POINTS
        ? row.service_name : null;
      const serviceSort = safeInteger(row.service_sort);
      const attendanceDate = typeof row.attendance_date === 'string' && isValidDateStr(row.attendance_date)
        ? row.attendance_date : null;
      const adultCount = safeInteger(row.adult_count);
      const childCount = row.child_count === null ? null : safeInteger(row.child_count);
      const combinedCount = adultCount !== null && childCount !== null ? adultCount + childCount : null;
      if (
        serviceTypeId === null || serviceName === null || serviceSort === null || attendanceDate === null
        || adultCount === null || adultCount < 0 || adultCount > SERVICE_ATTENDANCE_LIMITS.maxAdultCount
        || (childCount !== null && (
          childCount < 0 || childCount > SERVICE_ATTENDANCE_LIMITS.maxAdultCount
        ))
        || (combinedCount !== null && !Number.isSafeInteger(combinedCount))
      ) throw new ServiceAttendancePersistenceError();
      report.push({
        serviceTypeId, serviceName, serviceSort, attendanceDate, adultCount, childCount, combinedCount,
      });
    }
    return report;
  } catch (error) {
    if (
      error instanceof ServiceAttendanceInvalidError
      || error instanceof ServiceAttendanceReportLimitError
    ) throw error;
    throw new ServiceAttendancePersistenceError();
  }
}
