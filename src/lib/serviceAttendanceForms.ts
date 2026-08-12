import { addDays, isValidDateStr } from './dates';
import type { FormResult } from './validate';

export const SERVICE_ATTENDANCE_LIMITS = {
  maxAdultCount: 100_000,
  defaultWindowDays: 84,
  maxWindowDays: 366,
  maxCheckinEvents: 100,
} as const;

export const ATTENDANCE_FORM_ERROR_CODES = [
  'attendance_service_invalid',
  'attendance_count_invalid',
  'attendance_date_invalid',
  'attendance_checkin_event_invalid',
  'attendance_checkin_event_limit',
  'attendance_window_invalid',
  'attendance_window_limit',
] as const;

export type AttendanceFormErrorCode = typeof ATTENDANCE_FORM_ERROR_CODES[number];

export interface AdultCountInput {
  serviceTypeId: number;
  attendanceDate: string;
  adultCount: number;
}

export interface ServiceCheckinLinkInput {
  serviceTypeId: number;
  eventIds: number[];
}

export interface AttendanceWindow {
  from: string;
  to: string;
  days: number;
}

const ERROR = {
  service: 'attendance_service_invalid',
  count: 'attendance_count_invalid',
  date: 'attendance_date_invalid',
  event: 'attendance_checkin_event_invalid',
  eventLimit: 'attendance_checkin_event_limit',
  window: 'attendance_window_invalid',
  windowLimit: 'attendance_window_limit',
} as const satisfies Record<string, AttendanceFormErrorCode>;

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

function positiveId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseAdultCountForm(form: FormData): FormResult<AdultCountInput> {
  const errors: Record<string, string> = {};
  const serviceTypeId = positiveId(text(form, 'service_type_id'));
  if (serviceTypeId === null) errors.service_type_id = ERROR.service;

  const attendanceDate = text(form, 'attendance_date');
  if (!isValidDateStr(attendanceDate)) errors.attendance_date = ERROR.date;

  const countText = text(form, 'adult_count');
  const adultCount = Number(countText);
  if (!/^\d+$/.test(countText) || !Number.isSafeInteger(adultCount) || adultCount > SERVICE_ATTENDANCE_LIMITS.maxAdultCount) {
    errors.adult_count = ERROR.count;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: { serviceTypeId: serviceTypeId!, attendanceDate, adultCount },
  };
}

export function parseServiceCheckinLinkForm(form: FormData): FormResult<ServiceCheckinLinkInput> {
  const errors: Record<string, string> = {};
  const serviceTypeId = positiveId(text(form, 'service_type_id'));
  if (serviceTypeId === null) errors.service_type_id = ERROR.service;

  const rawEventIds = form.getAll('checkin_event_id').map((value) => String(value).trim());
  let eventIds: number[] = [];
  if (rawEventIds.length > SERVICE_ATTENDANCE_LIMITS.maxCheckinEvents) {
    errors.checkin_event_id = ERROR.eventLimit;
  } else {
    const parsed = rawEventIds.map(positiveId);
    if (parsed.some((value) => value === null)) {
      errors.checkin_event_id = ERROR.event;
    } else {
      eventIds = [...new Set(parsed as number[])].sort((left, right) => left - right);
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data: { serviceTypeId: serviceTypeId!, eventIds } };
}

function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function parseAttendanceWindow(
  params: URLSearchParams,
  today: string,
): FormResult<AttendanceWindow> {
  if (!isValidDateStr(today)) return { ok: false, errors: { window: ERROR.window } };

  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  const defaulted = rawFrom === null && rawTo === null;
  const from = defaulted ? addDays(today, -(SERVICE_ATTENDANCE_LIMITS.defaultWindowDays - 1)) : (rawFrom ?? '').trim();
  const to = defaulted ? today : (rawTo ?? '').trim();

  const errors: Record<string, string> = {};
  if (!isValidDateStr(from)) errors.from = ERROR.date;
  if (!isValidDateStr(to)) errors.to = ERROR.date;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (from > to) return { ok: false, errors: { window: ERROR.window } };

  const days = inclusiveDays(from, to);
  if (days > SERVICE_ATTENDANCE_LIMITS.maxWindowDays) {
    return { ok: false, errors: { window: ERROR.windowLimit } };
  }
  return { ok: true, data: { from, to, days } };
}
