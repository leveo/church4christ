import { describe, expect, it } from 'vitest';
import {
  buildActivitySummary,
  filterActivityScores,
  scorePerson,
  sortActivityScores,
  validateActivityScoreConfig,
  type ActivityScoreConfig,
  type PersonActivityEvidence,
} from '../src/lib/activityScoreModel';

const config: ActivityScoreConfig = {
  windowDays: 90,
  includedStatuses: ['regular', 'member'],
  activeThreshold: 70,
  watchThreshold: 40,
  revision: 2,
  dimensions: {
    group_attendance: { enabled: true, weight: 50, targetCount: null },
    serving: { enabled: true, weight: 50, targetCount: 3 },
    registration: { enabled: false, weight: 0, targetCount: 2 },
    learning_engagement: { enabled: false, weight: 0, targetCount: 3 },
  },
};

const evidence: PersonActivityEvidence = {
  personId: 7,
  name: 'Grace Lin',
  membershipStatus: 'member',
  current: {
    group_attendance: { present: 1, opportunities: 2 },
    serving: { count: 3 },
  },
  previous: {
    group_attendance: { present: 2, opportunities: 2 },
    serving: { count: 0 },
  },
};

describe('validateActivityScoreConfig', () => {
  it('returns a detached normalized configuration', () => {
    const result = validateActivityScoreConfig(config);
    expect(result).toEqual(config);
    expect(result).not.toBe(config);
    expect(result.dimensions).not.toBe(config.dimensions);
  });

  it('rejects unsupported windows, empty eligibility, thresholds, targets, and weights', () => {
    expect(() => validateActivityScoreConfig({ ...config, windowDays: 45 })).toThrow(/configuration/i);
    expect(() => validateActivityScoreConfig({ ...config, includedStatuses: [] })).toThrow(/configuration/i);
    expect(() => validateActivityScoreConfig({ ...config, watchThreshold: 70 })).toThrow(/configuration/i);
    expect(() => validateActivityScoreConfig({
      ...config,
      dimensions: { ...config.dimensions, serving: { enabled: true, weight: 50, targetCount: 0 } },
    })).toThrow(/configuration/i);
    expect(() => validateActivityScoreConfig({
      ...config,
      dimensions: {
        ...config.dimensions,
        group_attendance: { enabled: true, weight: 60, targetCount: null },
      },
    })).toThrow(/configuration/i);
  });

  it('rejects duplicate or unknown membership statuses and unknown dimensions', () => {
    expect(() => validateActivityScoreConfig({ ...config, includedStatuses: ['member', 'member'] })).toThrow(/configuration/i);
    expect(() => validateActivityScoreConfig({ ...config, includedStatuses: ['member', 'private'] as never })).toThrow(/configuration/i);
    expect(() => validateActivityScoreConfig({
      ...config,
      dimensions: { ...config.dimensions, giving: { enabled: false, weight: 0, targetCount: 1 } } as never,
    })).toThrow(/configuration/i);
  });
});

describe('scorePerson', () => {
  it('scores rates and targets, combines weights, bands, and comparison trend', () => {
    expect(scorePerson(config, evidence, new Set(['group_attendance', 'serving']))).toEqual({
      personId: 7,
      name: 'Grace Lin',
      membershipStatus: 'member',
      score: 75,
      previousScore: 50,
      trend: 25,
      band: 'active',
      dimensions: {
        group_attendance: { score: 50, previousScore: 100, numerator: 1, denominator: 2, weight: 50, observed: true },
        serving: { score: 100, previousScore: 0, numerator: 3, denominator: 3, weight: 50, observed: true },
      },
    });
  });

  it('renormalizes available weights and gives zero for no recorded activity', () => {
    expect(scorePerson(config, evidence, new Set(['serving']))).toMatchObject({ score: 100, previousScore: 0 });
    const empty = scorePerson(config, {
      ...evidence,
      current: {},
      previous: {},
    }, new Set(['group_attendance', 'serving']));
    expect(empty).toMatchObject({ score: 0, previousScore: 0, trend: 0, band: 'limited' });
    expect(empty.dimensions.group_attendance).toMatchObject({ observed: false, numerator: 0, denominator: 0 });
    expect(empty.dimensions.serving).toMatchObject({ observed: false, numerator: 0, denominator: 3 });
  });

  it('caps count dimensions, rounds deterministically, and applies exact band boundaries', () => {
    const high = scorePerson(config, {
      ...evidence,
      current: { group_attendance: { present: 2, opportunities: 3 }, serving: { count: 9 } },
    }, new Set(['group_attendance', 'serving']));
    expect(high.score).toBe(84);
    expect(high.band).toBe('active');

    const watchConfig = { ...config, dimensions: {
      group_attendance: { enabled: true, weight: 100, targetCount: null },
      serving: { enabled: false, weight: 0, targetCount: 3 },
      registration: { enabled: false, weight: 0, targetCount: 2 },
      learning_engagement: { enabled: false, weight: 0, targetCount: 3 },
    } } satisfies ActivityScoreConfig;
    expect(scorePerson(watchConfig, {
      ...evidence, current: { group_attendance: { present: 2, opportunities: 5 } }, previous: {},
    }, new Set(['group_attendance'])).band).toBe('watch');
    expect(scorePerson(watchConfig, {
      ...evidence, current: { group_attendance: { present: 7, opportunities: 10 } }, previous: {},
    }, new Set(['group_attendance'])).band).toBe('active');
  });

  it('scores bounded Learning submissions with deterministic target rounding', () => {
    const learningConfig = {
      ...config,
      dimensions: {
        group_attendance: { enabled: false, weight: 0, targetCount: null },
        serving: { enabled: false, weight: 0, targetCount: 3 },
        registration: { enabled: false, weight: 0, targetCount: 2 },
        learning_engagement: { enabled: true, weight: 100, targetCount: 3 },
      },
    } as never;
    const result = scorePerson(learningConfig, {
      ...evidence,
      current: { learning_engagement: { count: 2 } } as never,
      previous: { learning_engagement: { count: 1 } } as never,
    }, new Set(['learning_engagement'] as never));
    expect(result).toMatchObject({ score: 67, previousScore: 33, trend: 34, band: 'watch' });
    expect(result.dimensions).toMatchObject({
      learning_engagement: {
        numerator: 2, denominator: 3, score: 67, previousScore: 33, weight: 100, observed: true,
      },
    });
  });

  it('rejects unavailable-all, unsafe ids/counts, impossible attendance, and ineligible status', () => {
    expect(() => scorePerson(config, evidence, new Set())).toThrow(/evidence/i);
    expect(() => scorePerson(config, { ...evidence, personId: 0 }, new Set(['serving']))).toThrow(/evidence/i);
    expect(() => scorePerson(config, {
      ...evidence, current: { group_attendance: { present: 3, opportunities: 2 } },
    }, new Set(['group_attendance']))).toThrow(/evidence/i);
    expect(() => scorePerson(config, { ...evidence, membershipStatus: 'visitor' }, new Set(['serving']))).toThrow(/evidence/i);
  });
});

describe('activity score collections', () => {
  const rows = [
    scorePerson(config, evidence, new Set(['group_attendance', 'serving'])),
    scorePerson(config, {
      ...evidence,
      personId: 8,
      name: 'Amy Chen',
      membershipStatus: 'regular',
      current: { group_attendance: { present: 0, opportunities: 2 } },
      previous: {},
    }, new Set(['group_attendance', 'serving'])),
  ];

  it('builds averages, band counts, and per-source coverage', () => {
    expect(buildActivitySummary(rows, ['group_attendance', 'serving'])).toEqual({
      eligibleCount: 2,
      average: 38,
      previousAverage: 25,
      change: 13,
      bands: { active: 1, watch: 0, limited: 1 },
      coverage: {
        group_attendance: { people: 2, eligible: 2 },
        serving: { people: 1, eligible: 2 },
      },
    });
    expect(buildActivitySummary([], ['serving'])).toEqual({
      eligibleCount: 0,
      average: null,
      previousAverage: null,
      change: null,
      bands: { active: 0, watch: 0, limited: 0 },
      coverage: { serving: { people: 0, eligible: 0 } },
    });
  });

  it('sorts lowest first and filters by normalized name, status, and band', () => {
    expect(sortActivityScores(rows).map((row) => row.personId)).toEqual([8, 7]);
    expect(filterActivityScores(rows, { query: ' grace ', membershipStatus: null, band: null }).map((row) => row.personId)).toEqual([7]);
    expect(filterActivityScores(rows, { query: '', membershipStatus: 'regular', band: 'limited' }).map((row) => row.personId)).toEqual([8]);
  });
});
