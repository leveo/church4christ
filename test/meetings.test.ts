// Pure date math for group meeting occurrences (Task 1 of the member-portal
// Phase 4 plan; consumed by /my/calendar and the ICS feed in later tasks).
// meeting_weekday follows the migration's 0=Sunday convention (matches
// src/lib/dates.ts's nextWeekday). Reference weekdays used below, derived
// from dates.test.ts's fixed point (2026-07-01 = Wednesday):
//   2026-06-01 = Monday    2026-06-03 = Wednesday
//   2026-07-05 = Sunday    2026-07-25 = Saturday   2026-07-26 = Sunday
//   2026-08-01 = Saturday  2026-08-02 = Sunday
import { describe, expect, it } from 'vitest';
import { computeMeetingDates } from '../src/lib/groupDb';

const CREATED_AT = '2026-01-01 00:00:00'; // Thursday; irrelevant unless noted

describe('computeMeetingDates', () => {
  it('weekly: every matching weekday, crossing a month boundary', () => {
    const dates = computeMeetingDates(
      { meeting_weekday: 0, meeting_frequency: 'weekly', term_start: null, term_end: null, created_at: CREATED_AT },
      '2026-07-25',
      '2026-08-08',
    );
    expect(dates).toEqual(['2026-07-26', '2026-08-02']);
  });

  it('biweekly: anchored to term_start when the group has a term', () => {
    const dates = computeMeetingDates(
      {
        meeting_weekday: 3, // Wednesday, matches term_start itself
        meeting_frequency: 'biweekly',
        term_start: '2026-07-01',
        term_end: null,
        created_at: CREATED_AT,
      },
      '2026-07-10',
      '2026-07-31',
    );
    // Cadence from the anchor (07-01, 07-15, 07-29, ...); 07-08 is skipped
    // because it's only one week after the anchor, not two.
    expect(dates).toEqual(['2026-07-15', '2026-07-29']);
  });

  it('biweekly: anchored to created_at when the group has no term', () => {
    const dates = computeMeetingDates(
      {
        meeting_weekday: 3, // Wednesday; created_at is a Monday, so the anchor rolls forward
        meeting_frequency: 'biweekly',
        term_start: null,
        term_end: null,
        created_at: '2026-06-01 09:00:00',
      },
      '2026-06-20',
      '2026-07-20',
    );
    // Anchor: nextWeekday(2026-06-01, Wed) = 2026-06-03; cadence 06-03,
    // 06-17, 07-01, 07-15, 07-29 ... clipped to the query window.
    expect(dates).toEqual(['2026-07-01', '2026-07-15']);
  });

  it('monthly: first matching weekday of each month', () => {
    const dates = computeMeetingDates(
      { meeting_weekday: 0, meeting_frequency: 'monthly', term_start: null, term_end: null, created_at: CREATED_AT },
      '2026-07-01',
      '2026-08-31',
    );
    expect(dates).toEqual(['2026-07-05', '2026-08-02']);
  });

  it('monthly: a month that starts ON the target weekday still yields that first day', () => {
    const dates = computeMeetingDates(
      { meeting_weekday: 6, meeting_frequency: 'monthly', term_start: null, term_end: null, created_at: CREATED_AT }, // Saturday
      '2026-08-01',
      '2026-08-31',
    );
    expect(dates).toEqual(['2026-08-01']);
  });

  it('clips to both term_start and term_end', () => {
    const dates = computeMeetingDates(
      {
        meeting_weekday: 0,
        meeting_frequency: 'weekly',
        term_start: '2026-07-10',
        term_end: '2026-07-20',
        created_at: CREATED_AT,
      },
      '2026-01-01',
      '2026-12-31',
    );
    expect(dates).toEqual(['2026-07-12', '2026-07-19']);
  });

  it('returns [] when meeting_weekday is null', () => {
    const dates = computeMeetingDates(
      { meeting_weekday: null, meeting_frequency: 'weekly', term_start: null, term_end: null, created_at: CREATED_AT },
      '2026-07-01',
      '2026-08-01',
    );
    expect(dates).toEqual([]);
  });

  it('treats a null frequency as weekly', () => {
    const dates = computeMeetingDates(
      { meeting_weekday: 0, meeting_frequency: null, term_start: null, term_end: null, created_at: CREATED_AT },
      '2026-07-01',
      '2026-07-15',
    );
    expect(dates).toEqual(['2026-07-05', '2026-07-12']);
  });

  it('returns [] when from is after to', () => {
    const dates = computeMeetingDates(
      { meeting_weekday: 0, meeting_frequency: 'weekly', term_start: null, term_end: null, created_at: CREATED_AT },
      '2026-07-20',
      '2026-07-01',
    );
    expect(dates).toEqual([]);
  });
});
