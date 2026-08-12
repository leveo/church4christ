import { csvCell } from './csv';
import {
  PEOPLE_IMPORT_HEADERS,
  PEOPLE_IMPORT_LIMITS,
  parsePeopleImport,
  type PeopleImportHeader,
} from './peopleImport';
import { isValidDateStr } from './dates';
import { MEMBERSHIP_STATUSES, type MembershipStatus } from './validate';

export const PEOPLE_EXPORT_LIMITS = {
  maxParts: 25,
  maxDataRows: 25 * PEOPLE_IMPORT_LIMITS.maxDataRows,
  maxCsvBytes: 25 * PEOPLE_IMPORT_LIMITS.maxBytes,
} as const;

export interface CanonicalPeopleExportHouseholdReference {
  stableKey: string;
  name: string;
  address: string | null;
  phone: string | null;
  role: 'adult' | 'child';
  primary: boolean;
}

export interface CanonicalPeopleExportDependentHouseholdReference {
  stableKey: string;
  name: string;
  address: string | null;
  phone: string | null;
  role: 'adult' | 'child';
}

export interface CanonicalPeopleExportPerson {
  stableKey: string;
  displayName: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  language: 'en' | 'zh' | null;
  membershipStatus: MembershipStatus;
  birthday: string | null;
  joinedOn: string | null;
  address: string | null;
  active: boolean;
  household: CanonicalPeopleExportHouseholdReference | null;
}

export interface CanonicalPeopleExportDependent {
  stableKey: string;
  displayName: string;
  household: CanonicalPeopleExportDependentHouseholdReference;
}

export interface CanonicalPeopleExportSource {
  today: string;
  people: readonly CanonicalPeopleExportPerson[];
  dependents: readonly CanonicalPeopleExportDependent[];
}

export interface CanonicalExportPart {
  number: number;
  rowCount: number;
  householdCount: number;
  csv: string;
}

export interface CanonicalExportRepairCounts {
  people: number;
  dependents: number;
  households: number;
  issues: number;
}

export type CanonicalExportResult =
  | { status: 'success'; parts: CanonicalExportPart[] }
  | { status: 'repair_required'; counts: CanonicalExportRepairCounts };

type CanonicalRow = Record<PeopleImportHeader, string>;
type HouseholdGroup = {
  stableKey: string;
  people: CanonicalPeopleExportPerson[];
  dependents: CanonicalPeopleExportDependent[];
};
type HouseholdMetadata = { name: string; address: string; phone: string };
type ExportUnit =
  | { kind: 'household'; group: HouseholdGroup }
  | { kind: 'standalone'; person: CanonicalPeopleExportPerson };
type PartBuilder = {
  rows: string[];
  householdCount: number;
  byteCount: number;
};

const HEADER = `${PEOPLE_IMPORT_HEADERS.join(',')}\r\n`;
const ENCODER = new TextEncoder();

function text(value: string | null): string {
  return value?.trim().normalize('NFC') ?? '';
}

function personRow(
  person: CanonicalPeopleExportPerson,
  householdKey: string,
  metadata?: HouseholdMetadata,
): CanonicalRow {
  const household = person.household;
  return {
    record_type: 'person',
    display_name: text(person.displayName),
    email: text(person.email).toLowerCase(),
    first_name: text(person.firstName),
    last_name: text(person.lastName),
    phone: text(person.phone),
    language: person.language ?? '',
    membership_status: person.membershipStatus,
    birthday: person.birthday ?? '',
    joined_on: person.joinedOn ?? '',
    address: text(person.address),
    active: String(person.active),
    household_key: householdKey,
    household_name: household ? metadata?.name ?? text(household.name) : '',
    household_address: household ? metadata?.address ?? text(household.address) : '',
    household_phone: household ? metadata?.phone ?? text(household.phone) : '',
    household_role: household?.role ?? '',
    household_primary: household ? String(household.primary) : '',
  };
}

function dependentRow(
  dependent: CanonicalPeopleExportDependent,
  householdKey: string,
  metadata?: HouseholdMetadata,
): CanonicalRow {
  return {
    record_type: 'dependent',
    display_name: text(dependent.displayName),
    email: '',
    first_name: '',
    last_name: '',
    phone: '',
    language: '',
    membership_status: '',
    birthday: '',
    joined_on: '',
    address: '',
    active: '',
    household_key: householdKey,
    household_name: metadata?.name ?? text(dependent.household.name),
    household_address: metadata?.address ?? text(dependent.household.address),
    household_phone: metadata?.phone ?? text(dependent.household.phone),
    household_role: dependent.household.role,
    household_primary: '',
  };
}

function serializeRow(row: CanonicalRow): string {
  return PEOPLE_IMPORT_HEADERS.map((header) => csvCell(row[header])).join(',');
}

function rowBytes(row: string): number {
  return ENCODER.encode(`${row}\r\n`).byteLength;
}

function identity(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareKeys(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const compared = compareStrings(left[index] ?? '', right[index] ?? '');
    if (compared !== 0) return compared;
  }
  return 0;
}

function personSortKey(person: CanonicalPeopleExportPerson): string[] {
  const row = personRow(person, '');
  return [
    identity(person.email),
    ...PEOPLE_IMPORT_HEADERS.map((header) => identity(row[header])),
    identity(person.stableKey),
    person.stableKey,
  ];
}

function dependentSortKey(dependent: CanonicalPeopleExportDependent): string[] {
  const row = dependentRow(dependent, '');
  return [
    identity(dependent.displayName),
    dependent.household.role,
    ...PEOPLE_IMPORT_HEADERS.map((header) => identity(row[header])),
    identity(dependent.stableKey),
    dependent.stableKey,
  ];
}

function primaryPerson(group: HouseholdGroup): CanonicalPeopleExportPerson | undefined {
  return group.people.find((person) => person.household?.primary && person.household.role === 'adult');
}

function householdReferences(
  group: HouseholdGroup,
): Array<CanonicalPeopleExportHouseholdReference | CanonicalPeopleExportDependentHouseholdReference> {
  return [
    ...group.people.map((person) => person.household!),
    ...group.dependents.map((dependent) => dependent.household),
  ];
}

function observedMetadata(
  group: HouseholdGroup,
  property: 'name' | 'address' | 'phone',
): string[] {
  return householdReferences(group)
    .map((reference) => text(reference[property]))
    .filter((value) => value !== '');
}

function canonicalHouseholdMetadata(group: HouseholdGroup): HouseholdMetadata {
  return {
    name: observedMetadata(group, 'name')[0] ?? '',
    address: observedMetadata(group, 'address')[0] ?? '',
    phone: observedMetadata(group, 'phone')[0] ?? '',
  };
}

function householdSortKey(group: HouseholdGroup): string[] {
  const metadata = canonicalHouseholdMetadata(group);
  const primary = primaryPerson(group);
  return [
    identity(metadata.name),
    identity(primary?.email ?? ''),
    identity(metadata.address),
    identity(metadata.phone),
    identity(group.stableKey),
    group.stableKey,
  ];
}

function bounded(value: number, maximum: number): number {
  return Math.min(Math.max(0, value), maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeArrayLength(value: unknown, maximum: number): number {
  return Array.isArray(value) ? bounded(value.length, maximum) : 0;
}

function safeHouseholdCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  const keys = new Set<string>();
  for (const collection of [value.people, value.dependents]) {
    if (!Array.isArray(collection)) continue;
    for (const member of collection) {
      if (!isRecord(member) || !isRecord(member.household)) continue;
      if (typeof member.household.stableKey !== 'string') continue;
      keys.add(member.household.stableKey);
      if (keys.size >= PEOPLE_IMPORT_LIMITS.maxHouseholds + 1) {
        return PEOPLE_IMPORT_LIMITS.maxHouseholds + 1;
      }
    }
  }
  return keys.size;
}

function repairRequired(
  source: unknown,
  householdCount: number | undefined,
  issueCount: number,
): CanonicalExportResult {
  const record = isRecord(source) ? source : null;
  return {
    status: 'repair_required',
    counts: {
      people: safeArrayLength(record?.people, PEOPLE_IMPORT_LIMITS.maxDataRows + 1),
      dependents: safeArrayLength(record?.dependents, PEOPLE_IMPORT_LIMITS.maxDataRows + 1),
      households: bounded(
        householdCount ?? safeHouseholdCount(source),
        PEOPLE_IMPORT_LIMITS.maxHouseholds + 1,
      ),
      issues: bounded(issueCount, PEOPLE_IMPORT_LIMITS.maxIssues),
    },
  };
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function validatePerson(value: unknown): number {
  if (!isRecord(value)) return 1;
  let issues = 0;
  if (typeof value.stableKey !== 'string') issues += 1;
  if (typeof value.displayName !== 'string') issues += 1;
  if (typeof value.email !== 'string') issues += 1;
  for (const field of ['firstName', 'lastName', 'phone', 'birthday', 'joinedOn', 'address'] as const) {
    if (!isNullableString(value[field])) issues += 1;
  }
  if (value.language !== null && value.language !== 'en' && value.language !== 'zh') issues += 1;
  if (!(MEMBERSHIP_STATUSES as readonly unknown[]).includes(value.membershipStatus)) issues += 1;
  if (typeof value.active !== 'boolean') issues += 1;

  if (value.household !== null) {
    if (!isRecord(value.household)) return issues + 1;
    if (typeof value.household.stableKey !== 'string') issues += 1;
    if (typeof value.household.name !== 'string') issues += 1;
    if (!isNullableString(value.household.address)) issues += 1;
    if (!isNullableString(value.household.phone)) issues += 1;
    if (value.household.role !== 'adult' && value.household.role !== 'child') issues += 1;
    if (typeof value.household.primary !== 'boolean') issues += 1;
  }
  return issues;
}

function validateDependent(value: unknown): number {
  if (!isRecord(value)) return 1;
  let issues = 0;
  if (typeof value.stableKey !== 'string') issues += 1;
  if (typeof value.displayName !== 'string') issues += 1;
  if (!isRecord(value.household)) return issues + 1;
  if (typeof value.household.stableKey !== 'string') issues += 1;
  if (typeof value.household.name !== 'string') issues += 1;
  if (!isNullableString(value.household.address)) issues += 1;
  if (!isNullableString(value.household.phone)) issues += 1;
  if (value.household.role !== 'adult' && value.household.role !== 'child') issues += 1;
  return issues;
}

function validateSource(
  value: unknown,
): { ok: true; source: CanonicalPeopleExportSource } | { ok: false; issueCount: number } {
  if (!isRecord(value)) return { ok: false, issueCount: 1 };
  let issueCount = typeof value.today === 'string' && isValidDateStr(value.today) ? 0 : 1;
  if (!Array.isArray(value.people)) issueCount += 1;
  if (!Array.isArray(value.dependents)) issueCount += 1;
  if (Array.isArray(value.people)) {
    for (const person of value.people) issueCount += validatePerson(person);
  }
  if (Array.isArray(value.dependents)) {
    for (const dependent of value.dependents) issueCount += validateDependent(dependent);
  }
  return issueCount === 0
    ? { ok: true, source: value as unknown as CanonicalPeopleExportSource }
    : { ok: false, issueCount };
}

function excessiveInputIssueCount(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const peopleRows = Array.isArray(value.people) ? value.people.length : 0;
  const dependentRows = Array.isArray(value.dependents) ? value.dependents.length : 0;
  if (peopleRows + dependentRows <= PEOPLE_EXPORT_LIMITS.maxDataRows) return null;

  let issues = 1;
  if (typeof value.today !== 'string' || !isValidDateStr(value.today)) issues += 1;
  if (!Array.isArray(value.people)) issues += 1;
  if (!Array.isArray(value.dependents)) issues += 1;
  return issues;
}

function duplicateOccurrenceCount(values: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let duplicateOccurrences = 0;
  for (const value of values) {
    if ((counts.get(value) ?? 0) > 1) duplicateOccurrences += 1;
  }
  return duplicateOccurrences;
}

function structuralIssueCount(
  source: CanonicalPeopleExportSource,
  groups: readonly HouseholdGroup[],
): number {
  let issues = 0;
  issues += duplicateOccurrenceCount(source.people.map((person) => identity(person.email)));
  issues += duplicateOccurrenceCount(source.people.map((person) => person.stableKey));
  issues += duplicateOccurrenceCount(source.dependents.map((dependent) => dependent.stableKey));

  for (const person of source.people) {
    if (person.stableKey.trim() === '') issues += 1;
    if (person.household !== null && person.household.stableKey.trim() === '') issues += 1;
  }
  for (const dependent of source.dependents) {
    if (dependent.stableKey.trim() === '') issues += 1;
    if (dependent.household.stableKey.trim() === '') issues += 1;
  }

  for (const group of groups) {
    if (group.people.length === 0) issues += 1;
    const primaries = group.people.filter((person) => person.household?.primary);
    if (primaries.length === 0) {
      issues += 1;
    } else {
      if (primaries.length > 1) issues += 1;
      issues += primaries.filter((person) => person.household?.role !== 'adult').length;
    }

    const names = observedMetadata(group, 'name');
    const addresses = observedMetadata(group, 'address');
    const phones = observedMetadata(group, 'phone');
    if (names.length === 0) issues += 1;
    if (new Set(names).size > 1) issues += names.length;
    if (new Set(addresses).size > 1) issues += addresses.length;
    if (new Set(phones).size > 1) issues += phones.length;

    const dependentIdentities = group.dependents.map(
      (dependent) => `${identity(dependent.displayName)}\u0000${dependent.household.role}`,
    );
    issues += duplicateOccurrenceCount(dependentIdentities);
  }
  return issues;
}

function serializeUnit(
  unit: ExportUnit,
  nextHouseholdNumber: number,
): { rows: string[]; householdCount: 0 | 1; byteCount: number } {
  if (unit.kind === 'standalone') {
    const row = serializeRow(personRow(unit.person, ''));
    return { rows: [row], householdCount: 0, byteCount: rowBytes(row) };
  }

  const key = `household-${nextHouseholdNumber}`;
  const metadata = canonicalHouseholdMetadata(unit.group);
  const people = [...unit.group.people].sort(
    (left, right) => compareKeys(personSortKey(left), personSortKey(right)),
  );
  const dependents = [...unit.group.dependents].sort(
    (left, right) => compareKeys(dependentSortKey(left), dependentSortKey(right)),
  );
  const rows = [
    ...people.map((person) => serializeRow(personRow(person, key, metadata))),
    ...dependents.map((dependent) => serializeRow(dependentRow(dependent, key, metadata))),
  ];
  return {
    rows,
    householdCount: 1,
    byteCount: rows.reduce((total, row) => total + rowBytes(row), 0),
  };
}

function canAppend(
  part: PartBuilder,
  unit: ReturnType<typeof serializeUnit>,
): boolean {
  return part.rows.length + unit.rows.length <= PEOPLE_IMPORT_LIMITS.maxDataRows
    && part.householdCount + unit.householdCount <= PEOPLE_IMPORT_LIMITS.maxHouseholds
    && part.byteCount + unit.byteCount <= PEOPLE_IMPORT_LIMITS.maxBytes;
}

function completedPart(part: PartBuilder, number: number): CanonicalExportPart {
  return {
    number,
    rowCount: part.rows.length,
    householdCount: part.householdCount,
    csv: `${HEADER}${part.rows.map((row) => `${row}\r\n`).join('')}`,
  };
}

export function buildCanonicalExportParts(input: CanonicalPeopleExportSource): CanonicalExportResult {
  const excessiveInputIssues = excessiveInputIssueCount(input);
  if (excessiveInputIssues !== null) return repairRequired(input, 0, excessiveInputIssues);
  const validated = validateSource(input);
  if (!validated.ok) return repairRequired(input, undefined, validated.issueCount);
  const source = validated.source;
  const households = new Map<string, HouseholdGroup>();
  const standalone: CanonicalPeopleExportPerson[] = [];
  for (const person of source.people) {
    if (person.household === null) {
      standalone.push(person);
      continue;
    }
    const stableKey = person.household.stableKey;
    const group = households.get(stableKey) ?? { stableKey, people: [], dependents: [] };
    group.people.push(person);
    households.set(stableKey, group);
  }
  for (const dependent of source.dependents) {
    const stableKey = dependent.household.stableKey;
    const group = households.get(stableKey) ?? { stableKey, people: [], dependents: [] };
    group.dependents.push(dependent);
    households.set(stableKey, group);
  }

  const orderedHouseholds = [...households.values()].sort(
    (left, right) => compareKeys(householdSortKey(left), householdSortKey(right)),
  );
  const structuralIssues = structuralIssueCount(source, orderedHouseholds);
  if (structuralIssues > 0) return repairRequired(source, households.size, structuralIssues);

  const orderedStandalone = [...standalone].sort(
    (left, right) => compareKeys(personSortKey(left), personSortKey(right)),
  );
  const units: ExportUnit[] = [
    ...orderedHouseholds.map((group): ExportUnit => ({ kind: 'household', group })),
    ...orderedStandalone.map((person): ExportUnit => ({ kind: 'standalone', person })),
  ];
  const headerBytes = ENCODER.encode(HEADER).byteLength;
  const completed: CanonicalExportPart[] = [];
  let current: PartBuilder = { rows: [], householdCount: 0, byteCount: headerBytes };

  for (const unit of units) {
    let serialized = serializeUnit(unit, current.householdCount + 1);
    if (!canAppend(current, serialized) && current.rows.length > 0) {
      if (completed.length + 1 >= PEOPLE_EXPORT_LIMITS.maxParts) {
        return repairRequired(source, households.size, 1);
      }
      completed.push(completedPart(current, completed.length + 1));
      current = { rows: [], householdCount: 0, byteCount: headerBytes };
      serialized = serializeUnit(unit, 1);
    }
    if (!canAppend(current, serialized)) return repairRequired(source, households.size, 1);
    current.rows.push(...serialized.rows);
    current.householdCount += serialized.householdCount;
    current.byteCount += serialized.byteCount;
  }
  if (current.rows.length > 0 || completed.length === 0) {
    completed.push(completedPart(current, completed.length + 1));
  }

  let importerIssueCount = 0;
  for (const part of completed) {
    try {
      importerIssueCount += parsePeopleImport(ENCODER.encode(part.csv), { today: source.today }).errors.length;
    } catch {
      importerIssueCount += 1;
    }
  }
  if (importerIssueCount > 0) return repairRequired(source, households.size, importerIssueCount);

  return { status: 'success', parts: completed };
}
