import type { AppDb } from './appDb';
import {
  MAX_ACTIVITY_SCORE_PEOPLE,
  getActivityScoreConfig,
  listEligibleActivityPeople,
  listGroupAttendanceEvidence,
  listRegistrationEvidence,
  listServingEvidence,
  type ActivityCountEvidenceRow,
  type EligibleActivityPerson,
  type GroupAttendanceEvidenceRow,
} from './activityScoreDb';
import {
  ACTIVITY_DIMENSIONS,
  ActivityScoreEvidenceError,
  buildActivitySummary,
  scorePerson,
  sortActivityScores,
  validateActivityScoreConfig,
  type ActivityDimensionKey,
  type ActivityPeriodEvidence,
  type ActivityScoreConfig,
  type ActivityScoreSummary,
  type PersonActivityEvidence,
  type PersonActivityScore,
} from './activityScoreModel';
import { addDays, isValidDateStr } from './dates';

export class ActivityScoreReportError extends Error {
  readonly code = 'activity_score_report' as const;
  constructor() {
    super('Activity score report could not be built');
    this.name = 'ActivityScoreReportError';
  }
}

export interface ActivityScoreWindow {
  from: string;
  to: string;
}

export interface ActivityScoreReport {
  config: ActivityScoreConfig;
  windows: { current: ActivityScoreWindow; previous: ActivityScoreWindow };
  availableDimensions: ActivityDimensionKey[];
  unavailableDimensions: ActivityDimensionKey[];
  rows: PersonActivityScore[];
  summary: ActivityScoreSummary;
}

export interface ActivityScoreReaders {
  getConfig(db: AppDb): Promise<ActivityScoreConfig>;
  listPeople(db: AppDb, statuses: ActivityScoreConfig['includedStatuses'], limit: number): Promise<EligibleActivityPerson[]>;
  listGroup(db: AppDb, from: string, to: string, limit: number): Promise<GroupAttendanceEvidenceRow[]>;
  listServing(db: AppDb, from: string, to: string, limit: number): Promise<ActivityCountEvidenceRow[]>;
  listRegistration(db: AppDb, from: string, to: string, limit: number): Promise<ActivityCountEvidenceRow[]>;
}

const DEFAULT_READERS: ActivityScoreReaders = {
  getConfig: getActivityScoreConfig,
  listPeople: listEligibleActivityPeople,
  listGroup: listGroupAttendanceEvidence,
  listServing: listServingEvidence,
  listRegistration: listRegistrationEvidence,
};

const SOURCE_MODULE: Record<ActivityDimensionKey, string> = {
  group_attendance: 'groups',
  serving: 'serve',
  registration: 'registration',
};

function reportError(): never {
  throw new ActivityScoreReportError();
}

function validatePeople(people: EligibleActivityPerson[], config: ActivityScoreConfig): Map<number, PersonActivityEvidence> {
  if (!Array.isArray(people) || people.length > MAX_ACTIVITY_SCORE_PEOPLE) reportError();
  const evidence = new Map<number, PersonActivityEvidence>();
  for (const person of people) {
    if (
      !Number.isSafeInteger(person.personId) || person.personId <= 0 || evidence.has(person.personId)
      || typeof person.name !== 'string' || person.name.length < 1 || person.name.length > 2_000
      || !config.includedStatuses.includes(person.membershipStatus)
    ) reportError();
    evidence.set(person.personId, {
      ...person,
      current: {},
      previous: {},
    });
  }
  return evidence;
}

function addGroupRows(
  target: Map<number, PersonActivityEvidence>,
  period: 'current' | 'previous',
  rows: GroupAttendanceEvidenceRow[],
): void {
  if (!Array.isArray(rows) || rows.length > MAX_ACTIVITY_SCORE_PEOPLE) reportError();
  const seen = new Set<number>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.personId) || row.personId <= 0 || seen.has(row.personId)
      || !Number.isSafeInteger(row.present) || row.present < 0
      || !Number.isSafeInteger(row.opportunities) || row.opportunities < 1
      || row.present > row.opportunities
    ) reportError();
    seen.add(row.personId);
    const person = target.get(row.personId);
    if (person) person[period].group_attendance = { present: row.present, opportunities: row.opportunities };
  }
}

function addCountRows(
  target: Map<number, PersonActivityEvidence>,
  period: 'current' | 'previous',
  key: 'serving' | 'registration',
  rows: ActivityCountEvidenceRow[],
): void {
  if (!Array.isArray(rows) || rows.length > MAX_ACTIVITY_SCORE_PEOPLE) reportError();
  const seen = new Set<number>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.personId) || row.personId <= 0 || seen.has(row.personId)
      || !Number.isSafeInteger(row.count) || row.count < 1
    ) reportError();
    seen.add(row.personId);
    const person = target.get(row.personId);
    if (person) (person[period] as ActivityPeriodEvidence)[key] = { count: row.count };
  }
}

function unscoredSummary(eligibleCount: number): ActivityScoreSummary {
  return {
    eligibleCount,
    average: null,
    previousAverage: null,
    change: null,
    bands: { active: 0, watch: 0, limited: 0 },
    coverage: {},
  };
}

export async function buildActivityScoreReport(
  db: AppDb,
  modules: ReadonlySet<string>,
  today: string,
  readers: ActivityScoreReaders = DEFAULT_READERS,
): Promise<ActivityScoreReport> {
  if (!isValidDateStr(today)) reportError();
  try {
    const config = validateActivityScoreConfig(await readers.getConfig(db));
    const current = { from: addDays(today, -(config.windowDays - 1)), to: today };
    const previous = {
      to: addDays(current.from, -1),
      from: addDays(current.from, -config.windowDays),
    };
    const configured = ACTIVITY_DIMENSIONS.filter((key) => config.dimensions[key].enabled);
    const availableDimensions = configured.filter((key) => modules.has(SOURCE_MODULE[key]));
    const unavailableDimensions = configured.filter((key) => !modules.has(SOURCE_MODULE[key]));
    const people = await readers.listPeople(db, config.includedStatuses, MAX_ACTIVITY_SCORE_PEOPLE);
    const evidence = validatePeople(people, config);
    if (availableDimensions.length === 0) {
      return {
        config,
        windows: { current, previous },
        availableDimensions,
        unavailableDimensions,
        rows: [],
        summary: unscoredSummary(people.length),
      };
    }

    for (const key of availableDimensions) {
      if (key === 'group_attendance') {
        const currentRows = await readers.listGroup(db, current.from, current.to, MAX_ACTIVITY_SCORE_PEOPLE);
        const previousRows = await readers.listGroup(db, previous.from, previous.to, MAX_ACTIVITY_SCORE_PEOPLE);
        addGroupRows(evidence, 'current', currentRows);
        addGroupRows(evidence, 'previous', previousRows);
      } else {
        const reader = key === 'serving' ? readers.listServing : readers.listRegistration;
        const currentRows = await reader(db, current.from, current.to, MAX_ACTIVITY_SCORE_PEOPLE);
        const previousRows = await reader(db, previous.from, previous.to, MAX_ACTIVITY_SCORE_PEOPLE);
        addCountRows(evidence, 'current', key, currentRows);
        addCountRows(evidence, 'previous', key, previousRows);
      }
    }

    const available = new Set(availableDimensions);
    const rows = sortActivityScores([...evidence.values()].map((person) => scorePerson(config, person, available)));
    return {
      config,
      windows: { current, previous },
      availableDimensions,
      unavailableDimensions,
      rows,
      summary: buildActivitySummary(rows, availableDimensions),
    };
  } catch (error) {
    if (error instanceof ActivityScoreReportError) throw error;
    if (error instanceof ActivityScoreEvidenceError) throw new ActivityScoreReportError();
    throw error;
  }
}
