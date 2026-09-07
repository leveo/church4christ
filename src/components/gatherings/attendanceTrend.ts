interface AttendancePointSource {
  serviceTypeId: number;
  serviceName: string;
  attendanceDate: string;
  adultCount: number;
}
export interface AttendanceTrendSeries {
  id: number;
  name: string;
  points: { date: string; value: number }[];
}
export function buildAttendanceTrend(rows: readonly AttendancePointSource[]): {
  dates: string[]; series: AttendanceTrendSeries[]; max: number;
} {
  const byService = new Map<number, AttendanceTrendSeries>();
  for (const row of rows) {
    let series = byService.get(row.serviceTypeId);
    if (!series) {
      series = { id: row.serviceTypeId, name: row.serviceName, points: [] };
      byService.set(row.serviceTypeId, series);
    }
    series.points.push({ date: row.attendanceDate, value: row.adultCount });
  }
  for (const series of byService.values()) series.points.sort((a, b) => a.date.localeCompare(b.date));
  return {
    dates: [...new Set(rows.map((row) => row.attendanceDate))].sort(),
    series: [...byService.values()],
    max: rows.reduce((max, row) => Math.max(max, row.adultCount), 0),
  };
}
