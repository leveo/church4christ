import { describe, expect, it } from 'vitest';
import type { ServiceAttendanceReportRow } from '../src/lib/serviceAttendanceDb';
import { serializeServiceAttendanceCsv } from '../src/lib/serviceAttendanceCsv';

const row = (overrides: Partial<ServiceAttendanceReportRow> = {}): ServiceAttendanceReportRow => ({
  serviceTypeId: 1,
  serviceName: 'English Service',
  serviceSort: 1,
  attendanceDate: '2026-08-12',
  adultCount: 40,
  childCount: 12,
  combinedCount: 52,
  ...overrides,
});

describe('serializeServiceAttendanceCsv', () => {
  it('emits a deterministic UTF-8 RFC-4180-style CSV with CRLF and nullable child totals', () => {
    const csv = serializeServiceAttendanceCsv([
      row({ serviceTypeId: 2, serviceName: 'Chinese Service', serviceSort: 2, childCount: null, combinedCount: null }),
      row({ serviceTypeId: 3, attendanceDate: '2026-08-13', serviceName: 'Morning Service', serviceSort: 3 }),
      row({ serviceTypeId: 1, serviceName: 'English Service', serviceSort: 1 }),
    ]);
    expect(csv).toBe(
      'attendance_date,service_type_id,service_name,adult_count,child_count,combined_count\r\n' +
      '2026-08-13,3,Morning Service,40,12,52\r\n' +
      '2026-08-12,1,English Service,40,12,52\r\n' +
      '2026-08-12,2,Chinese Service,40,,\r\n',
    );
    expect(new TextDecoder().decode(new TextEncoder().encode(csv))).toBe(csv);
    expect(csv.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('preserves an exact derived child count above the adult-entry limit', () => {
    expect(serializeServiceAttendanceCsv([
      row({ adultCount: 1, childCount: 100001, combinedCount: 100002 }),
    ])).toContain(',1,100001,100002\r\n');
  });

  it('neutralizes a formula-like service name and never mutates input ordering', () => {
    const rows = [
      row({ serviceTypeId: 2, serviceName: '=HYPERLINK("https://example.com")', serviceSort: 2 }),
      row({ serviceTypeId: 1, serviceName: 'Plain', serviceSort: 1 }),
    ];
    const before = rows.map((entry) => entry.serviceTypeId);
    const csv = serializeServiceAttendanceCsv(rows);
    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/);
    expect(rows.map((entry) => entry.serviceTypeId)).toEqual(before);
  });

  it('rejects malformed or over-limit rows using one PII-free error', () => {
    const privateGetter = Object.defineProperty({}, 'serviceTypeId', {
      get() { throw new Error('PRIVATE CSV GETTER'); },
    });
    for (const rows of [
      [row({ adultCount: -1 })],
      [row({ childCount: null, combinedCount: 40 })],
      [row({ childCount: 1, combinedCount: 999 })],
      [row({ attendanceDate: 'private@example.com' })],
      [row({ serviceName: 'x'.repeat(1001) })],
      new Array(5001).fill(row()),
      [privateGetter],
    ]) {
      let error: unknown;
      try { serializeServiceAttendanceCsv(rows); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'attendance_csv_invalid' });
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/private|999/i);
    }
  });

  it('fails closed when valid-shaped rows exceed the total two-megabyte UTF-8 bound', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => row({
      serviceTypeId: index + 1,
      serviceName: '礼'.repeat(500),
    }));
    expect(() => serializeServiceAttendanceCsv(rows)).toThrow(expect.objectContaining({
      code: 'attendance_csv_invalid',
    }));
  });

  it('snapshots accessor-backed rows once so later private values cannot leak', () => {
    let reads = 0;
    const accessorRow = {
      ...row(),
      get serviceName() {
        reads += 1;
        return reads === 1 ? 'Public Service' : 'private@example.com';
      },
    };

    const csv = serializeServiceAttendanceCsv([accessorRow]);

    expect(csv).toContain(',Public Service,');
    expect(csv).not.toContain('private@example.com');
    expect(reads).toBe(1);
  });

  it('caches an array proxy length once before bounded iteration', () => {
    let lengthReads = 0;
    const rows = new Proxy([row()], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads += 1;
          return lengthReads === 1 ? 1 : 5001;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const csv = serializeServiceAttendanceCsv(rows);

    expect(csv.split('\r\n')).toHaveLength(3);
    expect(lengthReads).toBe(1);
  });
});
