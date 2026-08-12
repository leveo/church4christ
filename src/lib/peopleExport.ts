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

/** Minimal non-privileged projection required to reproduce canonical People row order. */
export type CanonicalPersonOrderPerson = Pick<
  CanonicalPeopleExportPerson,
  'stableKey' | 'email' | 'household'
>;

export type CanonicalPersonOrderResult =
  | { status: 'success'; stableKeys: string[] }
  | { status: 'repair_required'; issues: number };

export interface CanonicalPeopleExportDependent {
  stableKey: string;
  displayName: string;
  household: CanonicalPeopleExportDependentHouseholdReference;
}

export interface CanonicalPeopleExportSource {
  today: string;
  people: readonly CanonicalPeopleExportPerson[];
  dependents: readonly CanonicalPeopleExportDependent[];
  /** Numeric-only database integrity failures that cannot be represented as canonical rows. */
  integrityIssues?: number;
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

function personSortKey(person: CanonicalPersonOrderPerson): string[] {
  return [
    identity(person.email),
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

type HouseholdOrderGroup = {
  stableKey: string;
  people: CanonicalPersonOrderPerson[];
  dependents: CanonicalPeopleExportDependent[];
};

function primaryPerson(group: HouseholdOrderGroup): CanonicalPersonOrderPerson | undefined {
  return group.people.find((person) => person.household?.primary && person.household.role === 'adult');
}

function householdReferences(
  group: HouseholdOrderGroup,
): Array<CanonicalPeopleExportHouseholdReference | CanonicalPeopleExportDependentHouseholdReference> {
  return [
    ...group.people.map((person) => person.household!),
    ...group.dependents.map((dependent) => dependent.household),
  ];
}

function observedMetadata(
  group: HouseholdOrderGroup,
  property: 'name' | 'address' | 'phone',
): string[] {
  return householdReferences(group)
    .map((reference) => text(reference[property]))
    .filter((value) => value !== '');
}

function canonicalHouseholdMetadata(group: HouseholdOrderGroup): HouseholdMetadata {
  return {
    name: observedMetadata(group, 'name')[0] ?? '',
    address: observedMetadata(group, 'address')[0] ?? '',
    phone: observedMetadata(group, 'phone')[0] ?? '',
  };
}

function householdSortKey(group: HouseholdOrderGroup): string[] {
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

function orderedPersonStableKeys(people: readonly CanonicalPersonOrderPerson[]): string[] {
  const households = new Map<string, HouseholdOrderGroup>();
  const standalone: CanonicalPersonOrderPerson[] = [];
  for (const person of people) {
    if (person.household === null) {
      standalone.push(person);
      continue;
    }
    const stableKey = person.household.stableKey;
    const group = households.get(stableKey) ?? { stableKey, people: [], dependents: [] };
    group.people.push(person);
    households.set(stableKey, group);
  }
  const orderedHouseholds = [...households.values()].sort(
    (left, right) => compareKeys(householdSortKey(left), householdSortKey(right)),
  );
  const orderedStandalone = [...standalone].sort(
    (left, right) => compareKeys(personSortKey(left), personSortKey(right)),
  );
  return [
    ...orderedHouseholds.flatMap((group) => [...group.people].sort(
      (left, right) => compareKeys(personSortKey(left), personSortKey(right)),
    )),
    ...orderedStandalone,
  ].map((person) => person.stableKey);
}

function snapshotOrderPerson(value: unknown): { person: CanonicalPersonOrderPerson | null; issues: number } {
  if (!isRecord(value)) return { person: null, issues: 1 };
  const stableKey = value.stableKey;
  const email = value.email;
  const householdInput = value.household;
  let issues = 0;
  if (typeof stableKey !== 'string') issues += 1;
  if (typeof email !== 'string') issues += 1;
  let household: CanonicalPeopleExportHouseholdReference | null = null;
  if (householdInput !== null) {
    const captured = snapshotPersonHousehold(householdInput);
    issues += captured.issues;
    household = captured.value;
  }
  return {
    person: issues === 0 ? {
      stableKey: stableKey as string,
      email: email as string,
      household,
    } : null,
    issues,
  };
}

/**
 * Return file-local-safe stable keys in the exact People order used by canonical CSV rows.
 * Runtime-invalid, blank, or duplicate stable keys fail closed without returning PII.
 */
export function canonicalPersonStableKeyOrder(input: readonly CanonicalPersonOrderPerson[]): CanonicalPersonOrderResult {
  try {
    if (!Array.isArray(input)) return { status: 'repair_required', issues: 1 };
    if (input.length > PEOPLE_EXPORT_LIMITS.maxDataRows) {
      return { status: 'repair_required', issues: 1 };
    }
    const people: CanonicalPersonOrderPerson[] = [];
    let issues = 0;
    for (let index = 0; index < input.length; index += 1) {
      const captured = snapshotOrderPerson(input[index]);
      issues += captured.issues;
      if (captured.person) people.push(captured.person);
    }
    const keys = people.map((person) => person.stableKey);
    issues += duplicateOccurrenceCount(keys);
    issues += keys.filter((key) => key.trim() === '').length;
    if (issues > 0) {
      return { status: 'repair_required', issues: bounded(issues, PEOPLE_IMPORT_LIMITS.maxIssues) };
    }
    return { status: 'success', stableKeys: orderedPersonStableKeys(people) };
  } catch {
    return { status: 'repair_required', issues: 1 };
  }
}

function bounded(value: number, maximum: number): number {
  return Math.min(Math.max(0, value), maximum);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repairResult(
  peopleCount: number,
  dependentCount: number,
  householdCount: number,
  issueCount: number,
): CanonicalExportResult {
  return {
    status: 'repair_required',
    counts: {
      people: bounded(peopleCount, PEOPLE_IMPORT_LIMITS.maxDataRows + 1),
      dependents: bounded(dependentCount, PEOPLE_IMPORT_LIMITS.maxDataRows + 1),
      households: bounded(householdCount, PEOPLE_IMPORT_LIMITS.maxHouseholds + 1),
      issues: bounded(issueCount, PEOPLE_IMPORT_LIMITS.maxIssues),
    },
  };
}

function repairRequired(
  source: CanonicalPeopleExportSource,
  householdCount: number,
  issueCount: number,
): CanonicalExportResult {
  return repairResult(source.people.length, source.dependents.length, householdCount, issueCount);
}

function untrustedInputRepair(): CanonicalExportResult {
  return repairResult(0, 0, 0, 1);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

interface SnapshotValue<T> {
  value: T | null;
  issues: number;
  householdStableKey: string | null;
}

interface SnapshotFailure {
  ok: false;
  result: CanonicalExportResult;
}

interface SnapshotSuccess {
  ok: true;
  source: CanonicalPeopleExportSource;
}

function snapshotPersonHousehold(
  value: unknown,
): SnapshotValue<CanonicalPeopleExportHouseholdReference> {
  if (!isRecord(value)) return { value: null, issues: 1, householdStableKey: null };
  const stableKey = value.stableKey;
  const name = value.name;
  const address = value.address;
  const phone = value.phone;
  const role = value.role;
  const primary = value.primary;

  let issues = 0;
  if (typeof stableKey !== 'string') issues += 1;
  if (typeof name !== 'string') issues += 1;
  if (!isNullableString(address)) issues += 1;
  if (!isNullableString(phone)) issues += 1;
  if (role !== 'adult' && role !== 'child') issues += 1;
  if (typeof primary !== 'boolean') issues += 1;
  return {
    value: issues === 0 ? {
      stableKey: stableKey as string,
      name: name as string,
      address: address as string | null,
      phone: phone as string | null,
      role: role as 'adult' | 'child',
      primary: primary as boolean,
    } : null,
    issues,
    householdStableKey: typeof stableKey === 'string' ? stableKey : null,
  };
}

function snapshotDependentHousehold(
  value: unknown,
): SnapshotValue<CanonicalPeopleExportDependentHouseholdReference> {
  if (!isRecord(value)) return { value: null, issues: 1, householdStableKey: null };
  const stableKey = value.stableKey;
  const name = value.name;
  const address = value.address;
  const phone = value.phone;
  const role = value.role;

  let issues = 0;
  if (typeof stableKey !== 'string') issues += 1;
  if (typeof name !== 'string') issues += 1;
  if (!isNullableString(address)) issues += 1;
  if (!isNullableString(phone)) issues += 1;
  if (role !== 'adult' && role !== 'child') issues += 1;
  return {
    value: issues === 0 ? {
      stableKey: stableKey as string,
      name: name as string,
      address: address as string | null,
      phone: phone as string | null,
      role: role as 'adult' | 'child',
    } : null,
    issues,
    householdStableKey: typeof stableKey === 'string' ? stableKey : null,
  };
}

function snapshotPerson(value: unknown): SnapshotValue<CanonicalPeopleExportPerson> {
  if (!isRecord(value)) return { value: null, issues: 1, householdStableKey: null };
  const stableKey = value.stableKey;
  const displayName = value.displayName;
  const email = value.email;
  const firstName = value.firstName;
  const lastName = value.lastName;
  const phone = value.phone;
  const language = value.language;
  const membershipStatus = value.membershipStatus;
  const birthday = value.birthday;
  const joinedOn = value.joinedOn;
  const address = value.address;
  const active = value.active;
  const householdInput = value.household;

  let issues = 0;
  if (typeof stableKey !== 'string') issues += 1;
  if (typeof displayName !== 'string') issues += 1;
  if (typeof email !== 'string') issues += 1;
  if (!isNullableString(firstName)) issues += 1;
  if (!isNullableString(lastName)) issues += 1;
  if (!isNullableString(phone)) issues += 1;
  if (language !== null && language !== 'en' && language !== 'zh') issues += 1;
  if (!(MEMBERSHIP_STATUSES as readonly unknown[]).includes(membershipStatus)) issues += 1;
  if (!isNullableString(birthday)) issues += 1;
  if (!isNullableString(joinedOn)) issues += 1;
  if (!isNullableString(address)) issues += 1;
  if (typeof active !== 'boolean') issues += 1;

  let household: CanonicalPeopleExportHouseholdReference | null = null;
  let householdStableKey: string | null = null;
  if (householdInput !== null) {
    const snapshot = snapshotPersonHousehold(householdInput);
    issues += snapshot.issues;
    household = snapshot.value;
    householdStableKey = snapshot.householdStableKey;
  }

  return {
    value: issues === 0 ? {
      stableKey: stableKey as string,
      displayName: displayName as string,
      email: email as string,
      firstName: firstName as string | null,
      lastName: lastName as string | null,
      phone: phone as string | null,
      language: language as 'en' | 'zh' | null,
      membershipStatus: membershipStatus as MembershipStatus,
      birthday: birthday as string | null,
      joinedOn: joinedOn as string | null,
      address: address as string | null,
      active: active as boolean,
      household,
    } : null,
    issues,
    householdStableKey,
  };
}

function snapshotDependent(value: unknown): SnapshotValue<CanonicalPeopleExportDependent> {
  if (!isRecord(value)) return { value: null, issues: 1, householdStableKey: null };
  const stableKey = value.stableKey;
  const displayName = value.displayName;
  const householdInput = value.household;

  let issues = 0;
  if (typeof stableKey !== 'string') issues += 1;
  if (typeof displayName !== 'string') issues += 1;
  const household = snapshotDependentHousehold(householdInput);
  issues += household.issues;
  return {
    value: issues === 0 ? {
      stableKey: stableKey as string,
      displayName: displayName as string,
      household: household.value!,
    } : null,
    issues,
    householdStableKey: household.householdStableKey,
  };
}

function snapshotSource(
  value: unknown,
): SnapshotFailure | SnapshotSuccess {
  if (!isRecord(value)) return { ok: false, result: untrustedInputRepair() };
  const todayInput = value.today;
  const peopleInput = value.people;
  const dependentsInput = value.dependents;
  const integrityIssuesInput = value.integrityIssues;
  const peopleIsArray = Array.isArray(peopleInput);
  const dependentsIsArray = Array.isArray(dependentsInput);
  const peopleLength = peopleIsArray ? peopleInput.length : 0;
  const dependentLength = dependentsIsArray ? dependentsInput.length : 0;

  let issues = typeof todayInput === 'string' && isValidDateStr(todayInput) ? 0 : 1;
  let integrityIssues = 0;
  if (integrityIssuesInput !== undefined) {
    if (!Number.isSafeInteger(integrityIssuesInput) || (integrityIssuesInput as number) < 0) issues += 1;
    else integrityIssues = bounded(integrityIssuesInput as number, PEOPLE_IMPORT_LIMITS.maxIssues);
  }
  if (!peopleIsArray) issues += 1;
  if (!dependentsIsArray) issues += 1;
  if (peopleLength + dependentLength > PEOPLE_EXPORT_LIMITS.maxDataRows) {
    return {
      ok: false,
      result: repairResult(peopleLength, dependentLength, 0, issues + 1),
    };
  }

  const people: CanonicalPeopleExportPerson[] = [];
  const dependents: CanonicalPeopleExportDependent[] = [];
  const householdKeys = new Set<string>();
  if (peopleIsArray) {
    for (let index = 0; index < peopleLength; index += 1) {
      const memberInput = peopleInput[index];
      const snapshot = snapshotPerson(memberInput);
      issues += snapshot.issues;
      if (snapshot.value !== null) people.push(snapshot.value);
      if (snapshot.householdStableKey !== null) householdKeys.add(snapshot.householdStableKey);
    }
  }
  if (dependentsIsArray) {
    for (let index = 0; index < dependentLength; index += 1) {
      const memberInput = dependentsInput[index];
      const snapshot = snapshotDependent(memberInput);
      issues += snapshot.issues;
      if (snapshot.value !== null) dependents.push(snapshot.value);
      if (snapshot.householdStableKey !== null) householdKeys.add(snapshot.householdStableKey);
    }
  }

  if (issues > 0) {
    return {
      ok: false,
      result: repairResult(peopleLength, dependentLength, householdKeys.size, issues),
    };
  }
  return {
    ok: true,
    source: {
      today: todayInput as string,
      people,
      dependents,
      ...(integrityIssues > 0 ? { integrityIssues } : {}),
    },
  };
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
  let issues = source.integrityIssues ?? 0;
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
  const dependents = [...unit.group.dependents].sort(
    (left, right) => compareKeys(dependentSortKey(left), dependentSortKey(right)),
  );
  const rows = [
    ...unit.group.people.map((person) => serializeRow(personRow(person, key, metadata))),
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

function buildCanonicalExportPartsFromSnapshot(
  source: CanonicalPeopleExportSource,
): CanonicalExportResult {
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

  const householdGroups = [...households.values()];
  const structuralIssues = structuralIssueCount(source, householdGroups);
  if (structuralIssues > 0) return repairRequired(source, households.size, structuralIssues);

  const orderingPeople = source.people.map((person): CanonicalPersonOrderPerson => {
    if (person.household === null) return person;
    const group = households.get(person.household.stableKey)!;
    return {
      stableKey: person.stableKey,
      email: person.email,
      household: { ...person.household, ...canonicalHouseholdMetadata(group) },
    };
  });
  const canonicalOrder = canonicalPersonStableKeyOrder(orderingPeople);
  if (canonicalOrder.status !== 'success') {
    return repairRequired(source, households.size, canonicalOrder.issues);
  }
  const personRank = new Map(canonicalOrder.stableKeys.map((stableKey, index) => [stableKey, index]));
  for (const group of householdGroups) {
    group.people.sort((left, right) => personRank.get(left.stableKey)! - personRank.get(right.stableKey)!);
  }
  const orderedHouseholds = householdGroups.sort((left, right) =>
    personRank.get(left.people[0].stableKey)! - personRank.get(right.people[0].stableKey)!);
  const orderedStandalone = [...standalone].sort((left, right) =>
    personRank.get(left.stableKey)! - personRank.get(right.stableKey)!);
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

export function buildCanonicalExportParts(input: CanonicalPeopleExportSource): CanonicalExportResult {
  try {
    const snapshot = snapshotSource(input);
    return snapshot.ok ? buildCanonicalExportPartsFromSnapshot(snapshot.source) : snapshot.result;
  } catch {
    return untrustedInputRepair();
  }
}
