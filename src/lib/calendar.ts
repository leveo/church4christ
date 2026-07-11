// Shared month-calendar mark building for /my and /my/calendar. Pure — no D1.
// Ported from the reference stack's src/lib/calendar.ts unchanged.

export interface DayMark {
  statuses: ('U' | 'C' | 'D')[];
  blocked: boolean;
  /** Portal event titles landing on this day (Member Portal Phase 4 — empty/absent on D1). */
  events?: string[];
  /** Portal group-meeting labels landing on this day (Member Portal Phase 4 — empty/absent on D1). */
  meetings?: string[];
}

export interface CalendarMarksOptions {
  events?: { date: string; title: string }[];
  meetings?: { date: string; title: string }[];
}

/**
 * Build the per-day marks for one month ('YYYY-MM'): assignment status dots and
 * block-out shading. Assignments outside the month are ignored; blockout ranges
 * are clipped to the month by iterating its (at most 31) days. `options.events`/
 * `options.meetings` (Member Portal Phase 4, additive) attach portal event and
 * group-meeting titles to their day, also clipped to the month; callers that omit
 * them get the original two-mark behavior unchanged.
 */
export function buildCalendarMarks(
  assignments: { plan_date: string; status: 'U' | 'C' | 'D' }[],
  blockouts: { start_date: string; end_date: string }[],
  ym: string,
  options: CalendarMarksOptions = {},
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
  for (const e of options.events ?? []) {
    if (e.date.slice(0, 7) !== ym) continue;
    const mark = markOf(e.date);
    (mark.events ??= []).push(e.title);
  }
  for (const m of options.meetings ?? []) {
    if (m.date.slice(0, 7) !== ym) continue;
    const mark = markOf(m.date);
    (mark.meetings ??= []).push(m.title);
  }
  return marks;
}
