import { describe, expect, it } from 'vitest';
import { buildAttendanceTrend } from '../src/components/gatherings/attendanceTrend';

describe('gatherings attendance trend', () => {
  it('orders each service history without creating counts for missing dates', () => {
    const result = buildAttendanceTrend([
      { serviceTypeId: 2, serviceName: 'Afternoon', attendanceDate: '2026-08-09', adultCount: 80 },
      { serviceTypeId: 1, serviceName: 'Morning', attendanceDate: '2026-08-09', adultCount: 0 },
      { serviceTypeId: 1, serviceName: 'Morning', attendanceDate: '2026-08-02', adultCount: 120 },
    ]);
    expect(result.dates).toEqual(['2026-08-02', '2026-08-09']);
    expect(result.max).toBe(120);
    expect(result.series.find((series) => series.id === 1)?.points).toEqual([
      { date: '2026-08-02', value: 120 },
      { date: '2026-08-09', value: 0 },
    ]);
    expect(result.series.find((series) => series.id === 2)?.points).toEqual([
      { date: '2026-08-09', value: 80 },
    ]);
  });

  it('projects only service/date/count fields and never combines incomplete child counts', () => {
    const source = [{ serviceTypeId: 1, serviceName: 'Morning', attendanceDate: '2026-08-02', adultCount: 100,
      childCount: null, combinedCount: null, internalRecord: 'PRIVATE_SENTINEL' }];
    const result = buildAttendanceTrend(source);
    expect(result.series).toEqual([{ id: 1, name: 'Morning', points: [{ date: '2026-08-02', value: 100 }] }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(source[0].childCount).toBeNull();
    expect(buildAttendanceTrend([])).toEqual({ dates: [], series: [], max: 0 });
  });
});
