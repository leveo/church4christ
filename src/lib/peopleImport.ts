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
      record[header] = (cells[headerIndexes.get(header) ?? -1] ?? '').trim();
    }
    return record;
  });
}

function validateHeaders(
  headerCells: string[],
  issues: BoundedIssues,
): Map<PeopleImportHeader, number> | null {
  const trimmed = headerCells.map((cell) => cell.trim());
  if (trimmed.every((cell) => cell === '')) {
    issues.add({ code: 'missing_header', row: 1, field: null });
    return null;
  }

  const indexes = new Map<PeopleImportHeader, number>();
  let invalid = false;
  for (const [index, header] of trimmed.entries()) {
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
  const records = normalizedRows(parsed.rows.slice(1), headerIndexes);
  for (const [index, record] of records.entries()) {
    const row = index + 2;
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

  const model: PeopleImportModel = {
    people,
    dependents,
    households: [],
    summary: {
      dataRows: people.length + dependents.length,
      people: people.length,
      dependents: dependents.length,
      households: 0,
      inactivePeople: people.filter((person) => !person.active).length,
    },
  };
  return { model, ...issues.result() };
}
