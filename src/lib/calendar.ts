// Shared month-calendar mark building for /my and /my/calendar. Pure — no D1.
// Ported from dcfc-serve/src/lib/calendar.ts unchanged.

export interface DayMark {
  statuses: ('U' | 'C' | 'D')[];
  blocked: boolean;
}

/**
 * Build the per-day marks for one month ('YYYY-MM'): assignment status dots and
 * block-out shading. Assignments outside the month are ignored; blockout ranges
 * are clipped to the month by iterating its (at most 31) days.
 */
export function buildCalendarMarks(
  assignments: { plan_date: string; status: 'U' | 'C' | 'D' }[],
  blockouts: { start_date: string; end_date: string }[],
  ym: string,
): Map<string, DayMark> {
  const marks = new Map<string, DayMark>();
  const markOf = (d: string) => {
    let x = marks.get(d);
    if (!x) marks.set(d, (x = { statuses: [], blocked: false }));
    return x;
  };
  for (const a of assignments) if (a.plan_date.slice(0, 7) === ym) markOf(a.plan_date).statuses.push(a.status);
  for (const b of blockouts) {
    for (let d = 1; d <= 31; d++) {
      const date = `${ym}-${String(d).padStart(2, '0')}`;
      if (date >= b.start_date && date <= b.end_date) markOf(date).blocked = true;
    }
  }
  return marks;
}
