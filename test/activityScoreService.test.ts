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
    learning_engagement: { enabled: false, weight: 0, targetCount: 3 },
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
    hasLearningSource: vi.fn(async () => false),
    listLearning: vi.fn(async () => []),
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
    expect(report.sourceAvailability.learning_engagement).toBe(false);
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
    expect(source.listLearning).not.toHaveBeenCalled();
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
    expect(source.hasLearningSource).not.toHaveBeenCalled();
    expect(source.listLearning).not.toHaveBeenCalled();
  });

  it('queries registration only when both configured and available', async () => {
    const source = readers();
    source.getConfig = vi.fn(async () => ({
      ...config,
      dimensions: {
        group_attendance: { enabled: false, weight: 0, targetCount: null },
        serving: { enabled: false, weight: 0, targetCount: 2 },
        registration: { enabled: true, weight: 100, targetCount: 2 },
        learning_engagement: { enabled: false, weight: 0, targetCount: 3 },
      },
    }));
    source.listRegistration = vi.fn(async (_db, from) => from === '2026-07-14'
      ? [{ personId: 2, count: 1 }]
      : []);
    const report = await buildActivityScoreReport(db, new Set(['registration']), '2026-08-12', source);
    expect(source.listRegistration).toHaveBeenCalledTimes(2);
    expect(report.rows.map((row) => [row.personId, row.score])).toEqual([[1, 0], [2, 50]]);
  });

  it('keeps Learning unavailable until a provider source is active and never queries it while the module is off', async () => {
    const source = readers();
    source.getConfig = vi.fn(async () => ({
      ...config,
      dimensions: {
        group_attendance: { enabled: false, weight: 0, targetCount: null },
        serving: { enabled: false, weight: 0, targetCount: 2 },
        registration: { enabled: false, weight: 0, targetCount: 2 },
        learning_engagement: { enabled: true, weight: 100, targetCount: 3 },
      },
    } as never));
    const off = await buildActivityScoreReport(db, new Set(), '2026-08-12', source);
    expect(off.unavailableDimensions).toEqual(['learning_engagement']);
    expect(off.summary.average).toBeNull();
    expect(source.hasLearningSource).not.toHaveBeenCalled();
    expect(source.listLearning).not.toHaveBeenCalled();

    source.hasLearningSource = vi.fn(async () => false);
    const disconnected = await buildActivityScoreReport(db, new Set(['learning']), '2026-08-12', source);
    expect(disconnected.unavailableDimensions).toEqual(['learning_engagement']);
    expect(source.hasLearningSource).toHaveBeenCalledTimes(1);
    expect(source.listLearning).not.toHaveBeenCalled();
  });

  it('queries two inclusive Learning windows, renormalizes, and reports coverage', async () => {
    const source = readers();
    source.getConfig = vi.fn(async () => ({
      ...config,
      dimensions: {
        group_attendance: { enabled: true, weight: 40, targetCount: null },
        serving: { enabled: false, weight: 0, targetCount: 2 },
        registration: { enabled: false, weight: 0, targetCount: 2 },
        learning_engagement: { enabled: true, weight: 60, targetCount: 3 },
      },
    } as never));
    source.hasLearningSource = vi.fn(async () => true);
    source.listLearning = vi.fn(async (_db, from) => from === '2026-07-14'
      ? [{ personId: 1, count: 2 }]
      : [{ personId: 1, count: 1 }, { personId: 2, count: 3 }]);
    const report = await buildActivityScoreReport(db, new Set(['learning']), '2026-08-12', source);
    expect(source.listLearning).toHaveBeenNthCalledWith(1, db, '2026-07-14', '2026-08-12', 5_000, 5_000);
    expect(source.listLearning).toHaveBeenNthCalledWith(2, db, '2026-06-14', '2026-07-13', 5_000, 5_000);
    expect(report.availableDimensions).toEqual(['learning_engagement']);
    expect(report.unavailableDimensions).toEqual(['group_attendance']);
    expect(report.rows.map((row) => [row.personId, row.score, row.previousScore])).toEqual([
      [2, 0, 100],
      [1, 67, 33],
    ]);
    expect(report.summary.coverage.learning_engagement).toEqual({ people: 1, eligible: 2 });
    expect(source.listGroup).not.toHaveBeenCalled();
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
