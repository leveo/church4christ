import type { AppDb, AppDbResult } from './appDb';
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

export interface ServiceAttendanceReportRow {
  serviceTypeId: number;
  serviceName: string;
  serviceSort: number;
  attendanceDate: string;
  adultCount: number;
  childCount: number | null;
  combinedCount: number | null;
}

interface AdultDbRow {
  service_type_id: number;
  attendance_date: string;
  adult_count: number;
  recorded_by_person_id: number;
  updated_by_person_id: number;
  created_at: string;
  updated_at: string;
}

interface ReportDbRow {
  service_type_id: number;
  service_name: string;
  service_sort: number;
  attendance_date: string;
  adult_count: number;
  child_count: number | null;
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

function adultRow(row: AdultDbRow): ServiceAttendanceRow {
  return {
    serviceTypeId: Number(row.service_type_id),
    attendanceDate: row.attendance_date,
    adultCount: Number(row.adult_count),
    recordedByPersonId: Number(row.recorded_by_person_id),
    updatedByPersonId: Number(row.updated_by_person_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    ).first<AdultDbRow>();
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
    || eventIds.length > SERVICE_ATTENDANCE_LIMITS.maxCheckinEvents
    || eventIds.some((id) => !validPositiveId(id))
  ) throw new ServiceAttendanceInvalidError();
  return [...new Set(eventIds)].sort((left, right) => left - right);
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
  const revision = results[0]?.results[0] as { revision?: unknown } | undefined;
  const eventRows = results[1]?.results as Array<{ checkin_event_id?: unknown }> | undefined;
  if (
    !revision
    || !Number.isSafeInteger(Number(revision.revision))
    || !eventRows
    || eventRows.length > SERVICE_ATTENDANCE_LIMITS.maxCheckinEvents
  ) throw new ServiceAttendancePersistenceError();
  const eventIds = eventRows.map((row) => Number(row.checkin_event_id));
  if (eventIds.some((id) => !validPositiveId(id))) throw new ServiceAttendancePersistenceError();
  return { revision: Number(revision.revision), eventIds };
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

function casChanged(result: AppDbResult | undefined): boolean {
  return Boolean(result && (result.results.length === 1 || Number(result.meta.changes) === 1));
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
    if (!casChanged(results[0])) throw new ServiceAttendanceConflictError();
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
    const { results } = await db.prepare(`
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
    `).bind(locale, window.from, window.to).all<ReportDbRow>();
    if (results.length > MAX_SERVICE_ATTENDANCE_REPORT_ROWS) {
      throw new ServiceAttendanceReportLimitError();
    }
    return results.map((row) => {
      const adultCount = Number(row.adult_count);
      const childCount = row.child_count === null ? null : Number(row.child_count);
      return {
        serviceTypeId: Number(row.service_type_id),
        serviceName: row.service_name,
        serviceSort: Number(row.service_sort),
        attendanceDate: row.attendance_date,
        adultCount,
        childCount,
        combinedCount: childCount === null ? null : adultCount + childCount,
      };
    });
  } catch (error) {
    if (
      error instanceof ServiceAttendanceInvalidError
      || error instanceof ServiceAttendanceReportLimitError
    ) throw error;
    throw new ServiceAttendancePersistenceError();
  }
}
