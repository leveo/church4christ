import { csvCell } from './csv';
import { isValidDateStr } from './dates';
import {
  MAX_SERVICE_ATTENDANCE_REPORT_ROWS,
  type ServiceAttendanceReportRow,
} from './serviceAttendanceDb';
import { SERVICE_ATTENDANCE_LIMITS } from './serviceAttendanceForms';

const MAX_SERVICE_NAME_CODE_POINTS = 1_000;
const MAX_CSV_UTF8_BYTES = 2 * 1024 * 1024;

export class ServiceAttendanceCsvInvalidError extends Error {
  readonly code = 'attendance_csv_invalid' as const;
  constructor() {
    super('Service attendance CSV input is invalid');
    this.name = 'ServiceAttendanceCsvInvalidError';
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= SERVICE_ATTENDANCE_LIMITS.maxAdultCount;
}

function validRow(row: ServiceAttendanceReportRow): boolean {
  if (
    !row
    || !Number.isSafeInteger(row.serviceTypeId)
    || row.serviceTypeId <= 0
    || typeof row.serviceName !== 'string'
    || Array.from(row.serviceName).length > MAX_SERVICE_NAME_CODE_POINTS
    || !Number.isSafeInteger(row.serviceSort)
    || !isValidDateStr(row.attendanceDate)
    || !validCount(row.adultCount)
  ) return false;
  if (row.childCount === null || row.combinedCount === null) {
    return row.childCount === null && row.combinedCount === null;
  }
  return validCount(row.childCount)
    && Number.isSafeInteger(row.combinedCount)
    && row.combinedCount === row.adultCount + row.childCount;
}

function snapshotRow(row: ServiceAttendanceReportRow): ServiceAttendanceReportRow {
  return {
    serviceTypeId: row.serviceTypeId,
    serviceName: row.serviceName,
    serviceSort: row.serviceSort,
    attendanceDate: row.attendanceDate,
    adultCount: row.adultCount,
    childCount: row.childCount,
    combinedCount: row.combinedCount,
  };
}

export function serializeServiceAttendanceCsv(rows: readonly ServiceAttendanceReportRow[]): string {
  try {
    if (!Array.isArray(rows)) throw new ServiceAttendanceCsvInvalidError();
    const length = rows.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SERVICE_ATTENDANCE_REPORT_ROWS) {
      throw new ServiceAttendanceCsvInvalidError();
    }
    const snapshots: ServiceAttendanceReportRow[] = [];
    for (let index = 0; index < length; index += 1) {
      snapshots.push(snapshotRow(rows[index]));
    }
    if (snapshots.some((row) => !validRow(row))) throw new ServiceAttendanceCsvInvalidError();

    const ordered = snapshots.sort((left, right) =>
      right.attendanceDate.localeCompare(left.attendanceDate)
      || left.serviceSort - right.serviceSort
      || left.serviceTypeId - right.serviceTypeId,
    );
    const lines = [
      ['attendance_date', 'service_type_id', 'service_name', 'adult_count', 'child_count', 'combined_count']
        .map(csvCell).join(','),
      ...ordered.map((row) => [
        row.attendanceDate,
        row.serviceTypeId,
        row.serviceName,
        row.adultCount,
        row.childCount,
        row.combinedCount,
      ].map(csvCell).join(',')),
    ];
    const csv = `${lines.join('\r\n')}\r\n`;
    if (new TextEncoder().encode(csv).byteLength > MAX_CSV_UTF8_BYTES) {
      throw new ServiceAttendanceCsvInvalidError();
    }
    return csv;
  } catch {
    throw new ServiceAttendanceCsvInvalidError();
  }
}
