import { describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/lib/appDb';
import type { ActivityScoreConfig } from '../src/lib/activityScoreModel';
import { buildActivityScoreReport, type ActivityScoreReaders } from '../src/lib/activityScoreService';

const db = {} as AppDb;
const config: ActivityScoreConfig = {
  windowDays: 30,
  includedStatuses: ['member'],
  activeThreshold: 70,
  watchThreshold: 40,
  revision: 0,
  dimensions: {
    group_attendance: { enabled: true, weight: 50, targetCount: null },
    serving: { enabled: true, weight: 50, targetCount: 2 },
    registration: { enabled: false, weight: 0, targetCount: 2 },
  },
};

function readers(): ActivityScoreReaders {
  return {
    getConfig: vi.fn(async () => config),
    listPeople: vi.fn(async () => [
      { personId: 1, name: 'Amy', membershipStatus: 'member' as const },
      { personId: 2, name: 'Bea', membershipStatus: 'member' as const },
    ]),
    listGroup: vi.fn(async (_db, from) => from === '2026-07-14'
      ? [{ personId: 1, present: 1, opportunities: 2 }, { personId: 2, present: 0, opportunities: 1 }]
      : [{ personId: 1, present: 2, opportunities: 2 }]),
    listServing: vi.fn(async (_db, from) => from === '2026-07-14'
      ? [{ personId: 1, count: 2 }]
      : [{ personId: 2, count: 1 }]),
    listRegistration: vi.fn(async () => []),
  };
}

describe('buildActivityScoreReport', () => {
  it('builds inclusive current/previous windows, scores all people, then summarizes', async () => {
    const source = readers();
    const report = await buildActivityScoreReport(db, new Set(['groups', 'serve']), '2026-08-12', source);
    expect(report.windows).toEqual({
      current: { from: '2026-07-14', to: '2026-08-12' },
      previous: { from: '2026-06-14', to: '2026-07-13' },
    });
    expect(source.listGroup).toHaveBeenNthCalledWith(1, db, '2026-07-14', '2026-08-12', 5_000);
    expect(source.listGroup).toHaveBeenNthCalledWith(2, db, '2026-06-14', '2026-07-13', 5_000);
    expect(report.availableDimensions).toEqual(['group_attendance', 'serving']);
    expect(report.unavailableDimensions).toEqual([]);
    expect(report.rows.map((row) => [row.personId, row.score, row.trend])).toEqual([
      [2, 0, -25],
      [1, 75, 25],
    ]);
    expect(report.summary).toMatchObject({ eligibleCount: 2, average: 38, previousAverage: 38, change: 0 });
  });

  it('renormalizes around unavailable sources, warns, and never queries them', async () => {
    const source = readers();
    const report = await buildActivityScoreReport(db, new Set(['groups']), '2026-08-12', source);
    expect(report.availableDimensions).toEqual(['group_attendance']);
    expect(report.unavailableDimensions).toEqual(['serving']);
    expect(source.listServing).not.toHaveBeenCalled();
    expect(report.rows.map((row) => [row.personId, row.score])).toEqual([[2, 0], [1, 50]]);
  });

  it('returns an unscored population and does not call source readers when all are unavailable', async () => {
    const source = readers();
    const report = await buildActivityScoreReport(db, new Set(), '2026-08-12', source);
    expect(report.rows).toEqual([]);
    expect(report.summary).toMatchObject({ eligibleCount: 2, average: null, previousAverage: null });
    expect(report.unavailableDimensions).toEqual(['group_attendance', 'serving']);
    expect(source.listGroup).not.toHaveBeenCalled();
    expect(source.listServing).not.toHaveBeenCalled();
  });

  it('queries registration only when both configured and available', async () => {
    const source = readers();
    source.getConfig = vi.fn(async () => ({
      ...config,
      dimensions: {
        group_attendance: { enabled: false, weight: 0, targetCount: null },
        serving: { enabled: false, weight: 0, targetCount: 2 },
        registration: { enabled: true, weight: 100, targetCount: 2 },
      },
    }));
    source.listRegistration = vi.fn(async (_db, from) => from === '2026-07-14'
      ? [{ personId: 2, count: 1 }]
      : []);
    const report = await buildActivityScoreReport(db, new Set(['registration']), '2026-08-12', source);
    expect(source.listRegistration).toHaveBeenCalledTimes(2);
    expect(report.rows.map((row) => [row.personId, row.score])).toEqual([[1, 0], [2, 50]]);
  });

  it('rejects invalid dates, duplicate people, and duplicate source evidence', async () => {
    await expect(buildActivityScoreReport(db, new Set(['groups']), '2026-02-30', readers())).rejects.toThrow(/report/i);
    const duplicatePeople = readers();
    duplicatePeople.listPeople = vi.fn(async () => [
      { personId: 1, name: 'Amy', membershipStatus: 'member' as const },
      { personId: 1, name: 'Amy', membershipStatus: 'member' as const },
    ]);
    await expect(buildActivityScoreReport(db, new Set(['groups']), '2026-08-12', duplicatePeople)).rejects.toThrow(/report/i);
    const duplicateEvidence = readers();
    duplicateEvidence.listGroup = vi.fn(async () => [
      { personId: 1, present: 1, opportunities: 1 },
      { personId: 1, present: 1, opportunities: 1 },
    ]);
    await expect(buildActivityScoreReport(db, new Set(['groups']), '2026-08-12', duplicateEvidence)).rejects.toThrow(/report/i);
  });
});
