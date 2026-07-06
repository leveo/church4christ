import { describe, it, expect } from 'vitest';
import {
  isValidDateStr,
  todayInTz,
  addDays,
  nextWeekday,
  formatDate,
  formatMonth,
  datetimeLocalToUtc,
  utcToDatetimeLocal,
} from '../src/lib/dates';

describe('isValidDateStr', () => {
  it('accepts real calendar dates only', () => {
    expect(isValidDateStr('2026-07-05')).toBe(true);
    expect(isValidDateStr('2026-02-30')).toBe(false);
    expect(isValidDateStr('26-7-5')).toBe(false);
    expect(isValidDateStr('2026-13-01')).toBe(false);
    expect(isValidDateStr('')).toBe(false);
  });
});

describe('todayInTz', () => {
  it('uses the Chicago calendar date by default, not UTC (summer, CDT)', () => {
    // 2026-07-02 03:30 UTC is still 2026-07-01 22:30 in Chicago
    expect(todayInTz('America/Chicago', new Date('2026-07-02T03:30:00Z'))).toBe('2026-07-01');
  });
  it('defaults the timezone to America/Chicago', () => {
    expect(todayInTz(undefined, new Date('2026-01-10T05:30:00Z'))).toBe('2026-01-09');
  });
  it('honors a different timezone', () => {
    expect(todayInTz('UTC', new Date('2026-07-02T03:30:00Z'))).toBe('2026-07-02');
  });
});

describe('addDays', () => {
  it('shifts forward and backward, crossing month and year boundaries', () => {
    expect(addDays('2026-07-05', -4)).toBe('2026-07-01');
    expect(addDays('2027-01-03', -4)).toBe('2026-12-30');
    expect(addDays('2026-07-05', 7)).toBe('2026-07-12');
  });
});

describe('nextWeekday', () => {
  it('returns the coming weekday, or the date itself when it already matches', () => {
    // 2026-07-01 is a Wednesday; 2026-07-05 is a Sunday
    expect(nextWeekday('2026-07-01', 0)).toBe('2026-07-05'); // next Sunday
    expect(nextWeekday('2026-07-05', 0)).toBe('2026-07-05'); // already Sunday
    expect(nextWeekday('2026-07-01', 3)).toBe('2026-07-01'); // already Wednesday
    expect(nextWeekday('2026-12-30', 0)).toBe('2027-01-03'); // crosses the year
  });
});

describe('formatDate', () => {
  it('formats per locale', () => {
    expect(formatDate('2026-07-05', 'en')).toBe('July 5, 2026');
    expect(formatDate('2026-07-05', 'zh')).toBe('2026年7月5日');
    expect(formatDate('2026-12-30', 'en')).toBe('December 30, 2026');
  });
});

describe('formatMonth', () => {
  it('formats a YYYY-MM key per locale', () => {
    expect(formatMonth('2026-07', 'en')).toBe('July 2026');
    expect(formatMonth('2026-07', 'zh')).toBe('2026年7月');
    expect(formatMonth('2026-12', 'en')).toBe('December 2026');
    expect(formatMonth('2025-01', 'zh')).toBe('2025年1月');
  });
});

describe('datetimeLocalToUtc', () => {
  it('converts a summer (CDT, UTC-5) local time', () => {
    expect(datetimeLocalToUtc('2026-07-05T20:00')).toBe('2026-07-06 01:00:00');
    expect(datetimeLocalToUtc('2026-07-03T18:00')).toBe('2026-07-03 23:00:00');
  });
  it('converts a winter (CST, UTC-6) local time', () => {
    expect(datetimeLocalToUtc('2026-01-10T20:00')).toBe('2026-01-11 02:00:00');
  });
  it('handles the spring-forward day on both sides of the jump', () => {
    expect(datetimeLocalToUtc('2026-03-08T01:30')).toBe('2026-03-08 07:30:00'); // still CST
    expect(datetimeLocalToUtc('2026-03-08T12:00')).toBe('2026-03-08 17:00:00'); // now CDT
  });
  it('handles the fall-back day after the transition', () => {
    expect(datetimeLocalToUtc('2026-11-01T12:00')).toBe('2026-11-01 18:00:00'); // back to CST
  });
  it('rejects invalid input', () => {
    expect(datetimeLocalToUtc('')).toBeNull();
    expect(datetimeLocalToUtc('2026-7-5T20:00')).toBeNull();
    expect(datetimeLocalToUtc('2026-07-05 20:00')).toBeNull();
    expect(datetimeLocalToUtc('2026-02-30T10:00')).toBeNull(); // calendar rollover
    expect(datetimeLocalToUtc('2026-07-05T24:30')).toBeNull(); // hour rollover
  });
});

describe('utcToDatetimeLocal', () => {
  it('converts UTC SQL timestamps to Chicago datetime-local values across DST', () => {
    expect(utcToDatetimeLocal('2026-07-03 23:00:00')).toBe('2026-07-03T18:00'); // CDT, UTC-5
    expect(utcToDatetimeLocal('2026-01-15 15:30:00')).toBe('2026-01-15T09:30'); // CST, UTC-6
    expect(utcToDatetimeLocal(null)).toBe('');
    expect(utcToDatetimeLocal('garbage')).toBe('');
  });
  it('round-trips with datetimeLocalToUtc', () => {
    const utc = datetimeLocalToUtc('2026-07-05T20:00');
    expect(utc).not.toBeNull();
    expect(utcToDatetimeLocal(utc)).toBe('2026-07-05T20:00');
  });
});
