import { describe, expect, it } from 'vitest';
import {
  parseAdultCountForm,
  parseAttendanceWindow,
  parseServiceCheckinLinkForm,
} from '../src/lib/serviceAttendanceForms';

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

describe('parseAdultCountForm', () => {
  it('accepts both adult-count boundaries and a real strict calendar date', () => {
    expect(parseAdultCountForm(form({
      service_type_id: '7', attendance_date: '2028-02-29', adult_count: '0',
    }))).toEqual({
      ok: true,
      data: { serviceTypeId: 7, attendanceDate: '2028-02-29', adultCount: 0 },
    });
    expect(parseAdultCountForm(form({
      service_type_id: '7', attendance_date: '2026-12-31', adult_count: '100000',
    }))).toMatchObject({ ok: true, data: { adultCount: 100000 } });
  });

  it.each(['', ' ', '-1', '1.5', '1e2', '+1', '100001'])('rejects invalid count %j with one safe code', (adultCount) => {
    expect(parseAdultCountForm(form({
      service_type_id: '7', attendance_date: '2026-08-12', adult_count: adultCount,
    }))).toEqual({ ok: false, errors: { adult_count: 'attendance_count_invalid' } });
  });

  it.each(['', '2026-2-03', '2026-02-30', 'not-private@example.com'])('rejects invalid date %j without echoing it', (attendanceDate) => {
    const result = parseAdultCountForm(form({
      service_type_id: '7', attendance_date: attendanceDate, adult_count: '12',
    }));
    expect(result).toEqual({ ok: false, errors: { attendance_date: 'attendance_date_invalid' } });
    expect(JSON.stringify(result)).not.toContain(attendanceDate || 'not-present');
  });

  it.each(['', '0', '-1', '1.2', 'private'])('rejects an invalid service id before use: %j', (serviceTypeId) => {
    expect(parseAdultCountForm(form({
      service_type_id: serviceTypeId, attendance_date: '2026-08-12', adult_count: '12',
    }))).toMatchObject({ ok: false, errors: { service_type_id: 'attendance_service_invalid' } });
  });
});

describe('parseServiceCheckinLinkForm', () => {
  it('accepts an empty unlink set and returns unique sorted positive event ids', () => {
    expect(parseServiceCheckinLinkForm(form({ service_type_id: '4' }))).toEqual({
      ok: true, data: { serviceTypeId: 4, eventIds: [] },
    });
    expect(parseServiceCheckinLinkForm(form({
      service_type_id: '4', checkin_event_id: ['9', '2', '9'],
    }))).toEqual({ ok: true, data: { serviceTypeId: 4, eventIds: [2, 9] } });
  });

  it('rejects malformed ids and a request larger than the bounded room limit', () => {
    for (const value of ['', '0', '-1', '1.2', 'private-room']) {
      expect(parseServiceCheckinLinkForm(form({
        service_type_id: '4', checkin_event_id: value,
      }))).toEqual({ ok: false, errors: { checkin_event_id: 'attendance_checkin_event_invalid' } });
    }
    expect(parseServiceCheckinLinkForm(form({
      service_type_id: '4',
      checkin_event_id: Array.from({ length: 101 }, (_, index) => String(index + 1)),
    }))).toEqual({ ok: false, errors: { checkin_event_id: 'attendance_checkin_event_limit' } });
  });
});

describe('parseAttendanceWindow', () => {
  it('defaults to an inclusive 84-day window ending today', () => {
    expect(parseAttendanceWindow(new URLSearchParams(), '2026-08-12')).toEqual({
      ok: true,
      data: { from: '2026-05-21', to: '2026-08-12', days: 84 },
    });
  });

  it('accepts a one-day and the inclusive 366-day maximum', () => {
    expect(parseAttendanceWindow(new URLSearchParams('from=2026-08-12&to=2026-08-12'), '2026-08-12'))
      .toEqual({ ok: true, data: { from: '2026-08-12', to: '2026-08-12', days: 1 } });
    expect(parseAttendanceWindow(new URLSearchParams('from=2024-01-01&to=2024-12-31'), '2026-08-12'))
      .toEqual({ ok: true, data: { from: '2024-01-01', to: '2024-12-31', days: 366 } });
  });

  it('rejects invalid, reversed, and over-limit windows with fixed codes', () => {
    expect(parseAttendanceWindow(new URLSearchParams('from=2026-02-30&to=2026-08-12'), '2026-08-12'))
      .toEqual({ ok: false, errors: { from: 'attendance_date_invalid' } });
    expect(parseAttendanceWindow(new URLSearchParams('from=2026-08-13&to=2026-08-12'), '2026-08-12'))
      .toEqual({ ok: false, errors: { window: 'attendance_window_invalid' } });
    expect(parseAttendanceWindow(new URLSearchParams('from=2024-01-01&to=2025-01-01'), '2026-08-12'))
      .toEqual({ ok: false, errors: { window: 'attendance_window_limit' } });
    expect(parseAttendanceWindow(new URLSearchParams(), 'private@example.com'))
      .toEqual({ ok: false, errors: { window: 'attendance_window_invalid' } });
  });
});
