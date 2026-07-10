// Pure mark-building for the personal month calendar (/my/calendar). Covers the
// original assignment-status/blockout marks plus the Member Portal Phase 4
// additive events/meetings marks (buildCalendarMarks's options param).
import { describe, expect, it } from 'vitest';
import { buildCalendarMarks } from '../src/lib/calendar';

describe('buildCalendarMarks', () => {
  it('marks assignment statuses on their plan_date, ignoring other months', () => {
    const marks = buildCalendarMarks(
      [
        { plan_date: '2026-07-05', status: 'C' },
        { plan_date: '2026-07-05', status: 'U' },
        { plan_date: '2026-06-30', status: 'D' },
      ],
      [],
      '2026-07',
    );
    expect(marks.get('2026-07-05')?.statuses).toEqual(['C', 'U']);
    expect(marks.has('2026-06-30')).toBe(false);
  });

  it('shades blockout ranges clipped to the month', () => {
    const marks = buildCalendarMarks([], [{ start_date: '2026-06-29', end_date: '2026-07-02' }], '2026-07');
    expect(marks.get('2026-07-01')?.blocked).toBe(true);
    expect(marks.get('2026-07-02')?.blocked).toBe(true);
    expect(marks.has('2026-06-29')).toBe(false);
  });

  it('omits events/meetings from DayMark when options is not passed (backward compatible)', () => {
    const marks = buildCalendarMarks([{ plan_date: '2026-07-05', status: 'C' }], [], '2026-07');
    const mark = marks.get('2026-07-05');
    expect(mark?.events).toBeUndefined();
    expect(mark?.meetings).toBeUndefined();
  });

  it('attaches event titles to their date, clipped to the month', () => {
    const marks = buildCalendarMarks([], [], '2026-07', {
      events: [
        { date: '2026-07-10', title: 'Youth Retreat' },
        { date: '2026-06-30', title: 'Out of month' },
      ],
    });
    expect(marks.get('2026-07-10')?.events).toEqual(['Youth Retreat']);
    expect(marks.has('2026-06-30')).toBe(false);
  });

  it('attaches meeting labels to their date, clipped to the month', () => {
    const marks = buildCalendarMarks([], [], '2026-07', {
      meetings: [
        { date: '2026-07-12', title: 'Young Adults · 7:00 PM · Room 203' },
        { date: '2026-08-02', title: 'Out of month' },
      ],
    });
    expect(marks.get('2026-07-12')?.meetings).toEqual(['Young Adults · 7:00 PM · Room 203']);
    expect(marks.has('2026-08-02')).toBe(false);
  });

  it('accumulates multiple events/meetings on the same day and merges with existing marks', () => {
    const marks = buildCalendarMarks(
      [{ plan_date: '2026-07-05', status: 'C' }],
      [{ start_date: '2026-07-05', end_date: '2026-07-05' }],
      '2026-07',
      {
        events: [
          { date: '2026-07-05', title: 'Picnic' },
          { date: '2026-07-05', title: 'Baptism' },
        ],
        meetings: [{ date: '2026-07-05', title: 'Small Group' }],
      },
    );
    const mark = marks.get('2026-07-05');
    expect(mark?.statuses).toEqual(['C']);
    expect(mark?.blocked).toBe(true);
    expect(mark?.events).toEqual(['Picnic', 'Baptism']);
    expect(mark?.meetings).toEqual(['Small Group']);
  });
});
