import { parseUtf8Csv, type CsvParseErrorCode } from './csvParse';
import { isValidDateStr } from './dates';
import { isEmail, MEMBERSHIP_STATUSES, type MembershipStatus } from './validate';

export const PEOPLE_IMPORT_LIMITS = {
  maxBytes: 256 * 1024,
  maxRows: 201,
  maxColumns: 18,
  maxCellChars: 5_000,
  maxDataRows: 200,
  maxHouseholds: 100,
  maxIssues: 100,
} as const;

export const PEOPLE_IMPORT_HEADERS = [
  'record_type',
  'display_name',
  'email',
  'first_name',
  'last_name',
  'phone',
  'language',
  'membership_status',
  'birthday',
  'joined_on',
  'address',
  'active',
  'household_key',
  'household_name',
  'household_address',
  'household_phone',
  'household_role',
  'household_primary',
] as const;

export type PeopleImportHeader = (typeof PEOPLE_IMPORT_HEADERS)[number];
export type PeopleImportIssueCode =
  | CsvParseErrorCode
  | 'empty_file'
  | 'missing_header'
  | 'duplicate_header'
  | 'unknown_header'
  | 'required'
  | 'too_long'
  | 'invalid_email'
  | 'invalid_option'
  | 'invalid_date'
  | 'future_date'
  | 'forbidden_field'
  | 'household_fields_without_key'
  | 'duplicate_email'
  | 'household_requires_person'
  | 'household_name_required'
  | 'household_primary_required'
  | 'household_primary_multiple'
  | 'household_primary_must_be_adult'
  | 'household_metadata_conflict'
  | 'duplicate_dependent'
  | 'duplicate_household_name'
  | 'too_many_households'
  | 'issues_truncated';

export interface PeopleImportIssue {
  severity: 'error' | 'warning';
  code: PeopleImportIssueCode;
  row: number | null;
  field: PeopleImportHeader | null;
}

export interface PeopleImportHouseholdReference {
  key: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  role: 'adult' | 'child';
  primary: boolean;
}

export interface PeopleImportPerson {
  row: number;
  recordType: 'person';
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
  role: 'member';
  household: PeopleImportHouseholdReference | null;
}

export interface PeopleImportDependent {
  row: number;
  recordType: 'dependent';
  displayName: string;
  household: PeopleImportHouseholdReference;
}

export interface PeopleImportHousehold {
  key: string;
  name: string;
  address: string | null;
  phone: string | null;
  primaryEmail: string;
  people: PeopleImportPerson[];
  dependents: PeopleImportDependent[];
}

export interface PeopleImportModel {
  people: PeopleImportPerson[];
  dependents: PeopleImportDependent[];
  households: PeopleImportHousehold[];
  summary: {
    dataRows: number;
    people: number;
    dependents: number;
    households: number;
    inactivePeople: number;
  };
}

type NormalizedRow = Record<PeopleImportHeader, string>;
type IssueInput = Omit<PeopleImportIssue, 'severity'> & { severity?: PeopleImportIssue['severity'] };

const HEADER_SET = new Set<string>(PEOPLE_IMPORT_HEADERS);
const HOUSEHOLD_METADATA_HEADERS = [
  'household_name',
  'household_address',
  'household_phone',
  'household_role',
  'household_primary',
] as const satisfies readonly PeopleImportHeader[];
const DEPENDENT_FORBIDDEN_HEADERS = [
  'email',
  'first_name',
  'last_name',
  'phone',
  'language',
  'membership_status',
  'birthday',
  'joined_on',
  'address',
  'active',
] as const satisfies readonly PeopleImportHeader[];

class BoundedIssues {
  private readonly issues: PeopleImportIssue[] = [];
  private truncated = false;

  add(input: IssueInput): void {
    if (this.truncated) return;
    const issue: PeopleImportIssue = { severity: input.severity ?? 'error', code: input.code, row: input.row, field: input.field };
    if (this.issues.length < PEOPLE_IMPORT_LIMITS.maxIssues) {
      this.issues.push(issue);
      return;
    }
    this.issues[PEOPLE_IMPORT_LIMITS.maxIssues - 1] = {
      severity: 'error',
      code: 'issues_truncated',
      row: null,
      field: null,
    };
    this.truncated = true;
  }

  result(): { errors: PeopleImportIssue[]; warnings: PeopleImportIssue[] } {
    return {
      errors: this.issues.filter((issue) => issue.severity === 'error'),
      warnings: this.issues.filter((issue) => issue.severity === 'warning'),
    };
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function optional(value: string): string | null {
  return value === '' ? null : value;
}

function normalizedRows(rows: string[][], headerIndexes: Map<PeopleImportHeader, number>): NormalizedRow[] {
  return rows.map((cells) => {
    const record = {} as NormalizedRow;
    for (const header of PEOPLE_IMPORT_HEADERS) {
      record[header] = (cells[headerIndexes.get(header) ?? -1] ?? '').trim().normalize('NFC');
    }
    return record;
  });
}

function validateHeaders(
  headerCells: string[],
  issues: BoundedIssues,
): Map<PeopleImportHeader, number> | null {
  if (headerCells.every((cell) => cell.trim() === '')) {
    issues.add({ code: 'missing_header', row: 1, field: null });
    return null;
  }

  const indexes = new Map<PeopleImportHeader, number>();
  let invalid = false;
  for (const [index, header] of headerCells.entries()) {
    if (!HEADER_SET.has(header)) {
      issues.add({ code: 'unknown_header', row: 1, field: null });
      invalid = true;
      continue;
    }
    const canonical = header as PeopleImportHeader;
    if (indexes.has(canonical)) {
      issues.add({ code: 'duplicate_header', row: 1, field: canonical });
      invalid = true;
      continue;
    }
    indexes.set(canonical, index);
  }

  for (const header of PEOPLE_IMPORT_HEADERS) {
    if (!indexes.has(header)) {
      issues.add({ code: 'missing_header', row: 1, field: header });
      invalid = true;
    }
  }
  return invalid ? null : indexes;
}

function lengthValue(
  value: string,
  max: number,
  field: PeopleImportHeader,
  invalid: (code: PeopleImportIssueCode, field: PeopleImportHeader) => void,
): string | null {
  if (value === '') return null;
  if (codePointLength(value) > max) invalid('too_long', field);
  return value;
}

function householdMetadata(
  record: NormalizedRow,
  invalid: (code: PeopleImportIssueCode, field: PeopleImportHeader) => void,
): Pick<PeopleImportHouseholdReference, 'name' | 'address' | 'phone'> {
  return {
    name: lengthValue(record.household_name, 80, 'household_name', invalid),
    address: lengthValue(record.household_address, 200, 'household_address', invalid),
    phone: lengthValue(record.household_phone, 40, 'household_phone', invalid),
  };
}

function normalizePerson(
  record: NormalizedRow,
  row: number,
  issues: BoundedIssues,
  today: string,
): PeopleImportPerson | null {
  let valid = true;
  const invalid = (code: PeopleImportIssueCode, field: PeopleImportHeader): void => {
    valid = false;
    issues.add({ code, row, field });
  };

  const displayName = record.display_name;
  if (displayName === '') invalid('required', 'display_name');
  else if (codePointLength(displayName) > 80) invalid('too_long', 'display_name');

  const email = record.email.toLowerCase();
  if (email === '') invalid('required', 'email');
  else if (codePointLength(email) > 254) invalid('too_long', 'email');
  else if (!isEmail(email)) invalid('invalid_email', 'email');

  const firstName = lengthValue(record.first_name, 80, 'first_name', invalid);
  const lastName = lengthValue(record.last_name, 80, 'last_name', invalid);
  const phone = lengthValue(record.phone, 40, 'phone', invalid);
  const address = lengthValue(record.address, 200, 'address', invalid);

  const languageValue = record.language.toLowerCase();
  let language: PeopleImportPerson['language'] = null;
  if (languageValue === 'en' || languageValue === 'zh') language = languageValue;
  else if (languageValue !== '') invalid('invalid_option', 'language');

  const membershipValue = record.membership_status.toLowerCase();
  let membershipStatus: MembershipStatus = 'visitor';
  if (membershipValue !== '') {
    if ((MEMBERSHIP_STATUSES as readonly string[]).includes(membershipValue)) {
      membershipStatus = membershipValue as MembershipStatus;
    } else invalid('invalid_option', 'membership_status');
  }

  const birthday = optional(record.birthday);
  if (birthday !== null) {
    if (!isValidDateStr(birthday)) invalid('invalid_date', 'birthday');
    else if (birthday > today) invalid('future_date', 'birthday');
  }
  const joinedOn = optional(record.joined_on);
  if (joinedOn !== null && !isValidDateStr(joinedOn)) invalid('invalid_date', 'joined_on');

  const activeValue = record.active.toLowerCase();
  let active = true;
  if (activeValue === '' || activeValue === 'true') active = true;
  else if (activeValue === 'false') active = false;
  else invalid('invalid_option', 'active');

  const householdKey = record.household_key.toLowerCase();
  let household: PeopleImportHouseholdReference | null = null;
  if (householdKey === '') {
    for (const field of HOUSEHOLD_METADATA_HEADERS) {
      if (record[field] !== '') invalid('household_fields_without_key', field);
    }
  } else {
    if (!/^[a-z0-9._-]{1,64}$/.test(householdKey)) invalid('invalid_option', 'household_key');
    const metadata = householdMetadata(record, invalid);
    const roleValue = record.household_role.toLowerCase();
    let role: PeopleImportHouseholdReference['role'] = 'adult';
    if (roleValue === '') invalid('required', 'household_role');
    else if (roleValue === 'adult' || roleValue === 'child') role = roleValue;
    else invalid('invalid_option', 'household_role');

    const primaryValue = record.household_primary.toLowerCase();
    let primary = false;
    if (primaryValue === '') invalid('required', 'household_primary');
    else if (primaryValue === 'true') primary = true;
    else if (primaryValue === 'false') primary = false;
    else invalid('invalid_option', 'household_primary');

    household = { key: householdKey, ...metadata, role, primary };
  }

  if (!valid) return null;
  return {
    row,
    recordType: 'person',
    displayName,
    email,
    firstName,
    lastName,
    phone,
    language,
    membershipStatus,
    birthday,
    joinedOn,
    address,
    active,
    role: 'member',
    household,
  };
}

function normalizeDependent(
  record: NormalizedRow,
  row: number,
  issues: BoundedIssues,
): PeopleImportDependent | null {
  let valid = true;
  const invalid = (code: PeopleImportIssueCode, field: PeopleImportHeader): void => {
    valid = false;
    issues.add({ code, row, field });
  };

  const displayName = record.display_name;
  if (displayName === '') invalid('required', 'display_name');
  else if (codePointLength(displayName) > 80) invalid('too_long', 'display_name');

  const householdKey = record.household_key.toLowerCase();
  if (householdKey === '') invalid('required', 'household_key');
  else if (!/^[a-z0-9._-]{1,64}$/.test(householdKey)) invalid('invalid_option', 'household_key');

  for (const field of DEPENDENT_FORBIDDEN_HEADERS) {
    if (record[field] !== '') invalid('forbidden_field', field);
  }

  const metadata = householdMetadata(record, invalid);
  const roleValue = record.household_role.toLowerCase();
  let role: PeopleImportHouseholdReference['role'] = 'child';
  if (roleValue === '' || roleValue === 'child') role = 'child';
  else if (roleValue === 'adult') role = 'adult';
  else invalid('invalid_option', 'household_role');

  const primaryValue = record.household_primary.toLowerCase();
  if (primaryValue !== '' && primaryValue !== 'false') invalid('invalid_option', 'household_primary');

  if (!valid) return null;
  return {
    row,
    recordType: 'dependent',
    displayName,
    household: { key: householdKey, ...metadata, role, primary: false },
  };
}

type HouseholdMember = PeopleImportPerson | PeopleImportDependent;

interface HouseholdGroup {
  key: string;
  firstRow: number;
  people: PeopleImportPerson[];
  dependents: PeopleImportDependent[];
}

interface HouseholdCandidate {
  household: PeopleImportHousehold;
}

interface HouseholdNameObservation {
  firstRow: number;
  name: string;
}

function resolveHouseholdMetadata(
  members: HouseholdMember[],
  property: 'name' | 'address' | 'phone',
  field: 'household_name' | 'household_address' | 'household_phone',
  issues: BoundedIssues,
): { value: string | null; conflict: boolean } {
  const contributions: Array<{ row: number; value: string }> = [];
  for (const member of members) {
    const value = member.household?.[property] ?? null;
    if (value !== null) contributions.push({ row: member.row, value });
  }

  if (new Set(contributions.map((contribution) => contribution.value)).size > 1) {
    for (const contribution of contributions) {
      issues.add({ code: 'household_metadata_conflict', row: contribution.row, field });
    }
    return { value: null, conflict: true };
  }
  return { value: contributions[0]?.value ?? null, conflict: false };
}

function groupHouseholds(
  people: PeopleImportPerson[],
  dependents: PeopleImportDependent[],
  duplicateEmails: ReadonlySet<string>,
  issues: BoundedIssues,
): { people: PeopleImportPerson[]; dependents: PeopleImportDependent[]; households: PeopleImportHousehold[] } {
  const groups = new Map<string, HouseholdGroup>();
  const members: HouseholdMember[] = [...people, ...dependents].sort((left, right) => left.row - right.row);
  for (const member of members) {
    const household = member.household;
    if (household === null) continue;
    let group = groups.get(household.key);
    if (!group) {
      group = { key: household.key, firstRow: member.row, people: [], dependents: [] };
      groups.set(household.key, group);
    }
    if (member.recordType === 'person') group.people.push(member);
    else group.dependents.push(member);
  }

  const orderedGroups = [...groups.values()];

  const peopleByRow = new Map<number, PeopleImportPerson>();
  const dependentsByRow = new Map<number, PeopleImportDependent>();
  const candidates: HouseholdCandidate[] = [];
  const householdNames: HouseholdNameObservation[] = [];

  for (const group of orderedGroups) {
    let valid = true;
    const groupMembers: HouseholdMember[] = [...group.people, ...group.dependents].sort(
      (left, right) => left.row - right.row,
    );

    if (group.people.length === 0) {
      issues.add({ code: 'household_requires_person', row: group.firstRow, field: 'household_key' });
      valid = false;
    }

    const name = resolveHouseholdMetadata(groupMembers, 'name', 'household_name', issues);
    const address = resolveHouseholdMetadata(groupMembers, 'address', 'household_address', issues);
    const phone = resolveHouseholdMetadata(groupMembers, 'phone', 'household_phone', issues);
    if (name.conflict || address.conflict || phone.conflict) valid = false;
    if (!name.conflict && name.value === null) {
      issues.add({ code: 'household_name_required', row: group.firstRow, field: 'household_name' });
      valid = false;
    } else if (!name.conflict && name.value !== null) {
      householdNames.push({ firstRow: group.firstRow, name: name.value });
    }

    const adultPrimaries = group.people.filter(
      (person) => person.household?.primary && person.household.role === 'adult',
    );
    const childPrimaries = group.people.filter(
      (person) => person.household?.primary && person.household.role === 'child',
    );
    for (const person of childPrimaries) {
      issues.add({ code: 'household_primary_must_be_adult', row: person.row, field: 'household_primary' });
      valid = false;
    }
    if (adultPrimaries.length === 0) {
      issues.add({ code: 'household_primary_required', row: group.firstRow, field: 'household_primary' });
      valid = false;
    }
    if (adultPrimaries.length > 1) {
      for (const person of adultPrimaries) {
        issues.add({ code: 'household_primary_multiple', row: person.row, field: 'household_primary' });
      }
      valid = false;
    }

    const dependentsByIdentity = new Map<string, PeopleImportDependent[]>();
    for (const dependent of group.dependents) {
      const identity = `${dependent.displayName.trim().toLowerCase()}\u0000${dependent.household.role}`;
      const matching = dependentsByIdentity.get(identity) ?? [];
      matching.push(dependent);
      dependentsByIdentity.set(identity, matching);
    }
    for (const matching of dependentsByIdentity.values()) {
      if (matching.length < 2) continue;
      for (const dependent of matching) {
        issues.add({ code: 'duplicate_dependent', row: dependent.row, field: 'display_name' });
      }
      valid = false;
    }

    if (group.people.some((person) => duplicateEmails.has(person.email))) valid = false;
    if (!valid || name.value === null) continue;

    const canonicalPeople = group.people.map((person) => {
      const canonical = {
        ...person,
        household: {
          ...person.household!,
          name: name.value,
          address: address.value,
          phone: phone.value,
        },
      };
      peopleByRow.set(canonical.row, canonical);
      return canonical;
    });
    const canonicalDependents = group.dependents.map((dependent) => {
      const canonical = {
        ...dependent,
        household: {
          ...dependent.household,
          name: name.value,
          address: address.value,
          phone: phone.value,
        },
      };
      dependentsByRow.set(canonical.row, canonical);
      return canonical;
    });

    if (candidates.length >= PEOPLE_IMPORT_LIMITS.maxHouseholds) continue;
    candidates.push({
      household: {
        key: group.key,
        name: name.value,
        address: address.value,
        phone: phone.value,
        primaryEmail: adultPrimaries[0].email,
        people: canonicalPeople,
        dependents: canonicalDependents,
      },
    });
  }

  const householdNameCounts = new Map<string, number>();
  for (const observation of householdNames) {
    const normalizedName = observation.name.trim().normalize('NFC').toLowerCase();
    householdNameCounts.set(normalizedName, (householdNameCounts.get(normalizedName) ?? 0) + 1);
  }
  for (const observation of householdNames) {
    const normalizedName = observation.name.trim().normalize('NFC').toLowerCase();
    if ((householdNameCounts.get(normalizedName) ?? 0) > 1) {
      issues.add({
        severity: 'warning',
        code: 'duplicate_household_name',
        row: observation.firstRow,
        field: 'household_name',
      });
    }
  }

  return {
    people: people.map((person) => peopleByRow.get(person.row) ?? person),
    dependents: dependents.map((dependent) => dependentsByRow.get(dependent.row) ?? dependent),
    households: candidates.map((candidate) => candidate.household),
  };
}

export function parsePeopleImport(
  bytes: Uint8Array,
  options: { today: string },
): { model: PeopleImportModel | null; errors: PeopleImportIssue[]; warnings: PeopleImportIssue[] } {
  if (!isValidDateStr(options.today)) throw new RangeError('today must be a valid YYYY-MM-DD date');

  const issues = new BoundedIssues();
  const parsed = parseUtf8Csv(bytes, PEOPLE_IMPORT_LIMITS);
  if (!parsed.ok) {
    issues.add({ code: parsed.code, row: parsed.row, field: null });
    return { model: null, ...issues.result() };
  }
  if (parsed.rows.length === 0) {
    issues.add({ code: 'empty_file', row: null, field: null });
    return { model: null, ...issues.result() };
  }

  const headerIndexes = validateHeaders(parsed.rows[0], issues);
  if (headerIndexes === null) return { model: null, ...issues.result() };

  const people: PeopleImportPerson[] = [];
  const dependents: PeopleImportDependent[] = [];
  const emailOccurrences: Array<{ row: number; email: string }> = [];
  const householdKeys = new Set<string>();
  let householdLimitReported = false;
  const records = normalizedRows(parsed.rows.slice(1), headerIndexes);
  for (const [index, record] of records.entries()) {
    const row = index + 2;
    const email = record.email.toLowerCase();
    if (email !== '' && codePointLength(email) <= 254 && isEmail(email)) {
      emailOccurrences.push({ row, email });
    }
    const householdKey = record.household_key.toLowerCase();
    if (/^[a-z0-9._-]{1,64}$/.test(householdKey) && !householdKeys.has(householdKey)) {
      householdKeys.add(householdKey);
      if (!householdLimitReported && householdKeys.size > PEOPLE_IMPORT_LIMITS.maxHouseholds) {
        issues.add({ code: 'too_many_households', row, field: 'household_key' });
        householdLimitReported = true;
      }
    }

    const recordType = record.record_type.toLowerCase();
    if (recordType === '') {
      issues.add({ code: 'required', row, field: 'record_type' });
      continue;
    }
    if (recordType === 'person') {
      const person = normalizePerson(record, row, issues, options.today);
      if (person) people.push(person);
      continue;
    }
    if (recordType === 'dependent') {
      const dependent = normalizeDependent(record, row, issues);
      if (dependent) dependents.push(dependent);
      continue;
    }
    issues.add({ code: 'invalid_option', row, field: 'record_type' });
  }

  const emailCounts = new Map<string, number>();
  for (const occurrence of emailOccurrences) {
    emailCounts.set(occurrence.email, (emailCounts.get(occurrence.email) ?? 0) + 1);
  }
  const duplicateEmails = new Set<string>();
  for (const occurrence of emailOccurrences) {
    if ((emailCounts.get(occurrence.email) ?? 0) < 2) continue;
    duplicateEmails.add(occurrence.email);
    issues.add({ code: 'duplicate_email', row: occurrence.row, field: 'email' });
  }

  const grouped = groupHouseholds(people, dependents, duplicateEmails, issues);
  const model: PeopleImportModel = {
    people: grouped.people,
    dependents: grouped.dependents,
    households: grouped.households,
    summary: {
      dataRows: people.length + dependents.length,
      people: people.length,
      dependents: dependents.length,
      households: grouped.households.length,
      inactivePeople: people.filter((person) => !person.active).length,
    },
  };
  return { model, ...issues.result() };
}
