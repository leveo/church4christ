export const ACTIVITY_DIMENSIONS = [
  'group_attendance', 'serving', 'registration', 'learning_engagement',
] as const;
export type ActivityDimensionKey = (typeof ACTIVITY_DIMENSIONS)[number];

export const ACTIVITY_MEMBERSHIP_STATUSES = ['visitor', 'regular', 'member', 'inactive'] as const;
export type ActivityMembershipStatus = (typeof ACTIVITY_MEMBERSHIP_STATUSES)[number];
export type ActivityScoreBand = 'active' | 'watch' | 'limited';

export interface ActivityDimensionConfig {
  enabled: boolean;
  weight: number;
  targetCount: number | null;
}

export interface ActivityScoreConfig {
  windowDays: 30 | 60 | 90 | 180;
  includedStatuses: ActivityMembershipStatus[];
  activeThreshold: number;
  watchThreshold: number;
  revision: number;
  dimensions: Record<ActivityDimensionKey, ActivityDimensionConfig>;
}

export interface ActivityPeriodEvidence {
  group_attendance?: { present: number; opportunities: number };
  serving?: { count: number };
  registration?: { count: number };
  learning_engagement?: { count: number };
}

export interface PersonActivityEvidence {
  personId: number;
  name: string;
  membershipStatus: ActivityMembershipStatus;
  current: ActivityPeriodEvidence;
  previous: ActivityPeriodEvidence;
}

export interface ActivityDimensionScore {
  score: number;
  previousScore: number;
  numerator: number;
  denominator: number;
  weight: number;
  observed: boolean;
}

export interface PersonActivityScore {
  personId: number;
  name: string;
  membershipStatus: ActivityMembershipStatus;
  score: number;
  previousScore: number;
  trend: number;
  band: ActivityScoreBand;
  dimensions: Partial<Record<ActivityDimensionKey, ActivityDimensionScore>>;
}

export interface ActivityScoreSummary {
  eligibleCount: number;
  average: number | null;
  previousAverage: number | null;
  change: number | null;
  bands: Record<ActivityScoreBand, number>;
  coverage: Partial<Record<ActivityDimensionKey, { people: number; eligible: number }>>;
}

export class ActivityScoreConfigurationError extends Error {
  readonly code = 'activity_score_configuration' as const;
  constructor() {
    super('Activity score configuration is invalid');
    this.name = 'ActivityScoreConfigurationError';
  }
}

export class ActivityScoreEvidenceError extends Error {
  readonly code = 'activity_score_evidence' as const;
  constructor() {
    super('Activity score evidence is invalid');
    this.name = 'ActivityScoreEvidenceError';
  }
}

function dataObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return null;
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function configurationError(): never {
  throw new ActivityScoreConfigurationError();
}

export function validateActivityScoreConfig(value: unknown): ActivityScoreConfig {
  const row = dataObject(value);
  if (!row || !exactKeys(row, [
    'windowDays', 'includedStatuses', 'activeThreshold', 'watchThreshold', 'revision', 'dimensions',
  ])) configurationError();

  const windowDays = row.windowDays;
  if (windowDays !== 30 && windowDays !== 60 && windowDays !== 90 && windowDays !== 180) configurationError();
  if (!Array.isArray(row.includedStatuses) || row.includedStatuses.length < 1 || row.includedStatuses.length > 4) {
    configurationError();
  }
  const includedStatuses: ActivityMembershipStatus[] = [];
  for (const status of row.includedStatuses) {
    if (!(ACTIVITY_MEMBERSHIP_STATUSES as readonly unknown[]).includes(status) || includedStatuses.includes(status as ActivityMembershipStatus)) {
      configurationError();
    }
    includedStatuses.push(status as ActivityMembershipStatus);
  }
  if (
    !safeInteger(row.activeThreshold, 1, 100)
    || !safeInteger(row.watchThreshold, 0, 99)
    || row.watchThreshold >= row.activeThreshold
    || !safeInteger(row.revision, 0)
  ) configurationError();

  const dimensionsRow = dataObject(row.dimensions);
  if (!dimensionsRow || !exactKeys(dimensionsRow, ACTIVITY_DIMENSIONS)) configurationError();
  const dimensions = Object.create(null) as Record<ActivityDimensionKey, ActivityDimensionConfig>;
  let enabledWeight = 0;
  for (const key of ACTIVITY_DIMENSIONS) {
    const raw = dataObject(dimensionsRow[key]);
    if (!raw || !exactKeys(raw, ['enabled', 'weight', 'targetCount'])) configurationError();
    if (typeof raw.enabled !== 'boolean' || !safeInteger(raw.weight, 0, 100)) configurationError();
    if ((raw.enabled && raw.weight === 0) || (!raw.enabled && raw.weight !== 0)) configurationError();
    if (key === 'group_attendance') {
      if (raw.targetCount !== null) configurationError();
    } else if (!safeInteger(raw.targetCount, 1, 100)) {
      configurationError();
    }
    if (raw.enabled) enabledWeight += raw.weight;
    dimensions[key] = {
      enabled: raw.enabled,
      weight: raw.weight,
      targetCount: raw.targetCount as number | null,
    };
  }
  if (enabledWeight !== 100) configurationError();

  return {
    windowDays,
    includedStatuses,
    activeThreshold: row.activeThreshold,
    watchThreshold: row.watchThreshold,
    revision: row.revision,
    dimensions,
  };
}

function evidenceError(): never {
  throw new ActivityScoreEvidenceError();
}

function validateEvidenceKeys(value: ActivityPeriodEvidence): Record<string, unknown> {
  const row = dataObject(value);
  if (!row || Object.keys(row).some((key) => !(ACTIVITY_DIMENSIONS as readonly string[]).includes(key))) evidenceError();
  return row;
}

function groupDimension(value: unknown): { score: number; numerator: number; denominator: number; observed: boolean } {
  if (value === undefined) return { score: 0, numerator: 0, denominator: 0, observed: false };
  const row = dataObject(value);
  if (
    !row || !exactKeys(row, ['present', 'opportunities'])
    || !safeInteger(row.present, 0) || !safeInteger(row.opportunities, 0)
    || row.present > row.opportunities
  ) evidenceError();
  return {
    score: row.opportunities === 0 ? 0 : Math.round(100 * row.present / row.opportunities),
    numerator: row.present,
    denominator: row.opportunities,
    observed: row.opportunities > 0,
  };
}

function countDimension(value: unknown, target: number): { score: number; numerator: number; denominator: number; observed: boolean } {
  if (value === undefined) return { score: 0, numerator: 0, denominator: target, observed: false };
  const row = dataObject(value);
  if (!row || !exactKeys(row, ['count']) || !safeInteger(row.count, 0)) evidenceError();
  return {
    score: Math.round(100 * Math.min(row.count / target, 1)),
    numerator: row.count,
    denominator: target,
    observed: row.count > 0,
  };
}

function scoreBand(score: number, config: ActivityScoreConfig): ActivityScoreBand {
  if (score >= config.activeThreshold) return 'active';
  if (score >= config.watchThreshold) return 'watch';
  return 'limited';
}

export function scorePerson(
  rawConfig: ActivityScoreConfig,
  evidence: PersonActivityEvidence,
  availableDimensions: ReadonlySet<ActivityDimensionKey>,
): PersonActivityScore {
  const config = validateActivityScoreConfig(rawConfig);
  if (!(availableDimensions instanceof Set)) evidenceError();
  for (const key of availableDimensions) {
    if (!(ACTIVITY_DIMENSIONS as readonly string[]).includes(key)) evidenceError();
  }
  if (
    !safeInteger(evidence.personId, 1)
    || typeof evidence.name !== 'string' || evidence.name.length < 1 || evidence.name.length > 2_000
    || !config.includedStatuses.includes(evidence.membershipStatus)
  ) evidenceError();
  const current = validateEvidenceKeys(evidence.current);
  const previous = validateEvidenceKeys(evidence.previous);
  const activeAvailable = ACTIVITY_DIMENSIONS.filter((key) => config.dimensions[key].enabled && availableDimensions.has(key));
  if (activeAvailable.length === 0) evidenceError();
  const totalWeight = activeAvailable.reduce((sum, key) => sum + config.dimensions[key].weight, 0);
  const dimensions: Partial<Record<ActivityDimensionKey, ActivityDimensionScore>> = {};
  let currentWeighted = 0;
  let previousWeighted = 0;
  for (const key of activeAvailable) {
    const setting = config.dimensions[key];
    const currentResult = key === 'group_attendance'
      ? groupDimension(current[key])
      : countDimension(current[key], setting.targetCount!);
    const previousResult = key === 'group_attendance'
      ? groupDimension(previous[key])
      : countDimension(previous[key], setting.targetCount!);
    currentWeighted += currentResult.score * setting.weight;
    previousWeighted += previousResult.score * setting.weight;
    dimensions[key] = {
      score: currentResult.score,
      previousScore: previousResult.score,
      numerator: currentResult.numerator,
      denominator: currentResult.denominator,
      weight: setting.weight,
      observed: currentResult.observed,
    };
  }
  const score = Math.round(currentWeighted / totalWeight);
  const previousScore = Math.round(previousWeighted / totalWeight);
  return {
    personId: evidence.personId,
    name: evidence.name,
    membershipStatus: evidence.membershipStatus,
    score,
    previousScore,
    trend: score - previousScore,
    band: scoreBand(score, config),
    dimensions,
  };
}

export function buildActivitySummary(
  rows: readonly PersonActivityScore[],
  availableDimensions: readonly ActivityDimensionKey[],
): ActivityScoreSummary {
  const bands = { active: 0, watch: 0, limited: 0 } satisfies Record<ActivityScoreBand, number>;
  const coverage: ActivityScoreSummary['coverage'] = {};
  for (const key of availableDimensions) {
    if (!(ACTIVITY_DIMENSIONS as readonly string[]).includes(key) || coverage[key]) evidenceError();
    coverage[key] = { people: 0, eligible: rows.length };
  }
  let scoreTotal = 0;
  let previousTotal = 0;
  const ids = new Set<number>();
  for (const row of rows) {
    if (!safeInteger(row.personId, 1) || ids.has(row.personId) || !safeInteger(row.score, 0, 100) || !safeInteger(row.previousScore, 0, 100)) {
      evidenceError();
    }
    ids.add(row.personId);
    bands[row.band] += 1;
    scoreTotal += row.score;
    previousTotal += row.previousScore;
    for (const key of availableDimensions) {
      if (row.dimensions[key]?.observed) coverage[key]!.people += 1;
    }
  }
  if (rows.length === 0) {
    return { eligibleCount: 0, average: null, previousAverage: null, change: null, bands, coverage };
  }
  const average = Math.round(scoreTotal / rows.length);
  const previousAverage = Math.round(previousTotal / rows.length);
  return {
    eligibleCount: rows.length,
    average,
    previousAverage,
    change: average - previousAverage,
    bands,
    coverage,
  };
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

export function sortActivityScores(rows: readonly PersonActivityScore[]): PersonActivityScore[] {
  return [...rows].sort((left, right) =>
    left.score - right.score
    || normalizedName(left.name).localeCompare(normalizedName(right.name), 'en-US')
    || left.personId - right.personId,
  );
}

export interface ActivityScoreFilters {
  query: string;
  membershipStatus: ActivityMembershipStatus | null;
  band: ActivityScoreBand | null;
}

export function filterActivityScores(
  rows: readonly PersonActivityScore[],
  filters: ActivityScoreFilters,
): PersonActivityScore[] {
  const query = normalizedName(filters.query);
  return rows.filter((row) =>
    (!query || normalizedName(row.name).includes(query))
    && (!filters.membershipStatus || row.membershipStatus === filters.membershipStatus)
    && (!filters.band || row.band === filters.band),
  );
}
