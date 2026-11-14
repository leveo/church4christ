// Pure Service Planning logic: the run-sheet clock, availability windows, the
// status precedence, the find-a-time ranking and bounds, and the optimistic lock check.
import { describe, expect, it } from 'vitest';
import {
  computeRunSheet,
  dayAvailability,
  findCandidates,
  formatHM,
  monthDates,
  overlaps,
  parseHM,
  parseWeekdays,
  revisionMatches,
  serializeWeekdays,
  timeStatus,
  weekDates,
  windowCovers,
  type PersonFacts,
} from '../src/lib/planningModel';

const item = (id: number, duration_min: number, fixed_start_time: string | null = null) => ({
  id,
  kind: 'segment' as const,
  duration_min,
  fixed_start_time,
});

describe('time helpers', () => {
  it('parses and formats HH:MM', () => {
    expect(parseHM('09:30')).toBe(570);
    expect(parseHM('9:05')).toBe(545);
    expect(parseHM('24:00')).toBeNull();
    expect(parseHM('12:60')).toBeNull();
    expect(parseHM('')).toBeNull();
    expect(formatHM(570)).toBe('09:30');
    expect(formatHM(1440 + 5)).toBe('00:05');
  });

  it('treats intervals as half-open', () => {
    expect(overlaps(600, 660, 660, 720)).toBe(false);
    expect(overlaps(600, 661, 660, 720)).toBe(true);
    expect(overlaps(600, 660, 540, 600)).toBe(false);
  });
});

describe('computeRunSheet', () => {
  it('accumulates durations from the event start', () => {
    const { rows, summary } = computeRunSheet({ start_time: '10:00', end_time: '11:30' }, [item(1, 5), item(2, 30), item(3, 10)]);
    expect(rows.map((r) => r.start)).toEqual(['10:00', '10:05', '10:35']);
    expect(rows.map((r) => r.end)).toEqual(['10:05', '10:35', '10:45']);
    expect(summary).toMatchObject({ end: '10:45', totalMin: 45, overrun: false, overrunMin: 0, overlapCount: 0 });
  });

  it('jumps the clock to a later fixed start without flagging it', () => {
    const { rows, summary } = computeRunSheet({ start_time: '10:00', end_time: null }, [item(1, 5), item(2, 20, '10:30'), item(3, 10)]);
    expect(rows[1].start).toBe('10:30');
    expect(rows[1].overlap).toBe(false);
    expect(rows[2].start).toBe('10:50');
    expect(summary.targetEnd).toBeNull();
    expect(summary.overrun).toBe(false);
  });

  it('flags a fixed start earlier than the running clock as an overlap', () => {
    const { rows, summary } = computeRunSheet({ start_time: '10:00', end_time: null }, [item(1, 30), item(2, 10, '10:20')]);
    expect(rows[1]).toMatchObject({ start: '10:20', overlap: true, overlapMin: 10 });
    expect(summary.overlapCount).toBe(1);
  });

  it('warns when the total passes the target end', () => {
    const { summary } = computeRunSheet({ start_time: '10:00', end_time: '10:30' }, [item(1, 20), item(2, 25)]);
    expect(summary).toMatchObject({ end: '10:45', overrun: true, overrunMin: 15, targetEnd: '10:30' });
  });

  it('ends exactly on the target without a warning', () => {
    const { summary } = computeRunSheet({ start_time: '10:00', end_time: '10:45' }, [item(1, 45)]);
    expect(summary.overrun).toBe(false);
  });

  it('clamps bad durations', () => {
    const { summary } = computeRunSheet({ start_time: '10:00', end_time: null }, [item(1, -5), item(2, 99999)]);
    expect(summary.totalMin).toBe(720);
  });
});

describe('optimistic lock', () => {
  it('only matches the stored revision', () => {
    expect(revisionMatches(3, 3)).toBe(true);
    expect(revisionMatches(2, 3)).toBe(false);
    expect(revisionMatches(Number.NaN, 3)).toBe(false);
  });
});

describe('availability windows', () => {
  const weekly = { starts_on: '2030-06-01', ends_on: '2030-06-30', weekdays: '4,5', start_minute: 1080, end_minute: 1260 };

  it('parses comma lists and JSON text, ignoring junk', () => {
    expect(parseWeekdays('0,3')).toEqual([0, 3]);
    expect(parseWeekdays('[5, 1, 1]')).toEqual([1, 5]);
    expect(parseWeekdays('["2","9","x"]')).toEqual([2]);
    expect(parseWeekdays('')).toEqual([]);
    expect(serializeWeekdays([5, 1, 1, 9])).toBe('1,5');
  });

  it('applies on matching weekdays inside the date range only', () => {
    // 2030-06-06 is a Thursday, 2030-06-07 a Friday, 2030-06-08 a Saturday.
    expect(windowCovers(weekly, '2030-06-06', 1080, 1260)).toBe(true);
    expect(windowCovers(weekly, '2030-06-07', 1100, 1200)).toBe(true);
    expect(windowCovers(weekly, '2030-06-08', 1100, 1200)).toBe(false);
    expect(windowCovers(weekly, '2030-07-04', 1100, 1200)).toBe(false);
  });

  it('requires the whole slot to fit and uses half-open ends', () => {
    expect(windowCovers(weekly, '2030-06-06', 1050, 1200)).toBe(false);
    expect(windowCovers(weekly, '2030-06-06', 1200, 1261)).toBe(false);
    expect(windowCovers(weekly, '2030-06-06', 1200, 1260)).toBe(true);
  });

  it('treats empty weekdays as every day', () => {
    expect(windowCovers({ ...weekly, weekdays: '' }, '2030-06-08', 1100, 1200)).toBe(true);
  });
});

describe('timeStatus', () => {
  const base: PersonFacts = { blockouts: [], busy: [], windows: [] };
  const windows = [{ starts_on: '2030-06-06', ends_on: '2030-06-06', weekdays: '', start_minute: 540, end_minute: 720 }];

  it('is unknown with no information', () => {
    expect(timeStatus(base, '2030-06-06', 600, 660)).toBe('unknown');
  });

  it('is available when a window covers the slot', () => {
    expect(timeStatus({ ...base, windows }, '2030-06-06', 600, 660)).toBe('available');
  });

  it('prefers busy over available and blocked over busy', () => {
    const busy = [{ date: '2030-06-06', startMin: 630, endMin: 700 }];
    expect(timeStatus({ ...base, windows, busy }, '2030-06-06', 600, 660)).toBe('busy');
    const blockouts = [{ start_date: '2030-06-06', end_date: '2030-06-06', start_time: null, end_time: null }];
    expect(timeStatus({ blockouts, busy, windows }, '2030-06-06', 600, 660)).toBe('blocked');
  });

  it('does not collide with a commitment that ends exactly when the slot starts', () => {
    const busy = [{ date: '2030-06-06', startMin: 540, endMin: 600 }];
    expect(timeStatus({ ...base, windows, busy }, '2030-06-06', 600, 660)).toBe('available');
    expect(timeStatus({ ...base, windows, busy }, '2030-06-06', 599, 660)).toBe('busy');
  });

  it('respects the time range of a blockout and spans its dates', () => {
    const blockouts = [{ start_date: '2030-06-05', end_date: '2030-06-07', start_time: '18:00', end_time: '20:00' }];
    expect(timeStatus({ ...base, blockouts }, '2030-06-06', 1080, 1200)).toBe('blocked');
    expect(timeStatus({ ...base, blockouts }, '2030-06-06', 1200, 1260)).toBe('unknown');
    expect(timeStatus({ ...base, blockouts }, '2030-06-06', 1020, 1080)).toBe('unknown');
    expect(timeStatus({ ...base, blockouts }, '2030-06-08', 1080, 1200)).toBe('unknown');
  });
});

describe('findCandidates', () => {
  const free = (date: string): PersonFacts => ({
    blockouts: [],
    busy: [],
    windows: [{ starts_on: date, ends_on: date, weekdays: '', start_minute: 0, end_minute: 1440 }],
  });

  it('ranks fewest blocked first, then fewest unknown, then earliest', () => {
    const facts = new Map<number, PersonFacts>([
      [1, free('2030-06-04')],
      [2, { blockouts: [{ start_date: '2030-06-03', end_date: '2030-06-03', start_time: null, end_time: null }], busy: [], windows: [] }],
    ]);
    const out = findCandidates({
      dateFrom: '2030-06-03',
      dateTo: '2030-06-04',
      durationMin: 60,
      earliestMin: 9 * 60,
      latestMin: 11 * 60,
      people: [1, 2],
      facts,
    });
    // Day 06-03: person 2 blocked. Day 06-04: person 1 available, person 2 unknown.
    expect(out[0].date).toBe('2030-06-04');
    expect(out[0]).toMatchObject({ conflicts: 0, unknown: 1, available: 1 });
    expect(out[out.length - 1].date).toBe('2030-06-03');
    expect(out.every((c, i) => i === 0 || out[i - 1].conflicts <= c.conflicts)).toBe(true);
  });

  it('counts busy people as conflicts alongside blocked', () => {
    const facts = new Map<number, PersonFacts>([
      [1, { blockouts: [], busy: [{ date: '2030-06-03', startMin: 540, endMin: 660 }], windows: [] }],
    ]);
    const [first] = findCandidates({ dateFrom: '2030-06-03', dateTo: '2030-06-03', durationMin: 60, earliestMin: 540, latestMin: 780, people: [1], facts });
    expect(first.startMin).toBe(660);
    expect(first.conflicts).toBe(0);
  });

  it('steps in 30 minutes, respects the latest end, and the weekday filter', () => {
    const out = findCandidates({
      dateFrom: '2030-06-03',
      dateTo: '2030-06-09',
      durationMin: 90,
      weekdays: [0],
      earliestMin: 9 * 60,
      latestMin: 11 * 60,
      people: [],
      facts: new Map(),
      limit: 50,
    });
    // 2030-06-09 is the only Sunday; starts 9:00, 9:30 fit (ends 10:30, 11:00).
    expect(out.map((c) => `${c.date} ${c.start}`)).toEqual(['2030-06-09 09:00', '2030-06-09 09:30']);
  });

  it('is bounded to 31 days and a result limit', () => {
    const out = findCandidates({
      dateFrom: '2030-01-01',
      dateTo: '2031-12-31',
      durationMin: 60,
      earliestMin: 540,
      latestMin: 1200,
      people: [],
      facts: new Map(),
      limit: 1000,
    });
    const days = new Set(out.map((c) => c.date));
    expect(days.size).toBeLessThanOrEqual(31);
    expect([...days].sort().at(-1)).toBe('2030-01-31');
    expect(findCandidates({ dateFrom: '2030-01-01', dateTo: '2030-01-31', durationMin: 60, people: [], facts: new Map() }).length).toBe(12);
  });

  it('rejects a duration outside 15..600 minutes', () => {
    expect(findCandidates({ dateFrom: '2030-01-01', dateTo: '2030-01-02', durationMin: 5, people: [], facts: new Map() })).toEqual([]);
    expect(findCandidates({ dateFrom: '2030-01-01', dateTo: '2030-01-02', durationMin: 601, people: [], facts: new Map() })).toEqual([]);
  });
});

describe('calendar helpers', () => {
  it('summarizes one person on one day', () => {
    const facts: PersonFacts = {
      blockouts: [
        { start_date: '2030-06-06', end_date: '2030-06-06', start_time: null, end_time: null },
        { start_date: '2030-06-06', end_date: '2030-06-06', start_time: '08:00', end_time: '09:00' },
      ],
      busy: [{ date: '2030-06-06', startMin: 600, endMin: 660 }],
      windows: [{ starts_on: '2030-06-01', ends_on: '2030-06-30', weekdays: '4', start_minute: 1080, end_minute: 1260 }],
    };
    const day = dayAvailability(facts, '2030-06-06');
    expect(day.blocked).toEqual([
      { allDay: true, start: null, end: null },
      { allDay: false, start: '08:00', end: '09:00' },
    ]);
    expect(day.busy).toEqual([{ start: '10:00', end: '11:00' }]);
    expect(day.available).toEqual([{ start: '18:00', end: '21:00' }]);
    expect(dayAvailability(facts, '2030-06-07').available).toEqual([]);
  });

  it('lists a Sunday-to-Saturday week and a whole month', () => {
    expect(weekDates('2030-06-06')).toEqual(['2030-06-02', '2030-06-03', '2030-06-04', '2030-06-05', '2030-06-06', '2030-06-07', '2030-06-08']);
    expect(monthDates('2030-02')).toHaveLength(28);
    expect(monthDates('2030-06')[29]).toBe('2030-06-30');
  });
});
