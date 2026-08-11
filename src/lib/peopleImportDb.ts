import type { AppDb, AppStatement } from './appDb';
import { isUniqueViolation } from './adminDb';
import type { DbBackend } from './dbProvider';
import {
  PEOPLE_IMPORT_LIMITS,
  parsePeopleImport,
  type PeopleImportDependent,
  type PeopleImportHeader,
  type PeopleImportHousehold,
  type PeopleImportModel,
  type PeopleImportPerson,
} from './peopleImport';

export type PeopleImportValidationResult = ReturnType<typeof parsePeopleImport>;

export type PeopleImportDbIssueCode =
  | 'email_exists'
  | 'household_name_exists'
  | 'issues_truncated';

export interface PeopleImportDbIssue {
  severity: 'error' | 'warning';
  code: PeopleImportDbIssueCode;
  row: number | null;
  field: PeopleImportHeader | null;
}

export interface PeopleImportPreflightResult {
  errors: PeopleImportDbIssue[];
  warnings: PeopleImportDbIssue[];
}

export interface PeopleImportCommitResult {
  people: number;
  households: number;
  dependents: number;
}

export class PeopleImportNotReadyError extends Error {
  readonly code = 'import_not_ready' as const;

  constructor() {
    super('People import is not ready');
    this.name = 'PeopleImportNotReadyError';
  }
}

export class PeopleImportConflictError extends Error {
  readonly code = 'import_conflict' as const;

  constructor() {
    super('People import conflicts with existing data');
    this.name = 'PeopleImportConflictError';
  }
}

export class PeopleImportPersistenceError extends Error {
  readonly code = 'import_failed' as const;

  constructor() {
    super('People import failed');
    this.name = 'PeopleImportPersistenceError';
  }
}

type IdentifierKind = 'email' | 'household_name';

interface ImportedIdentifier {
  identity: string;
  row: number;
}

interface IdentifierRow {
  id: number;
  identifier: string;
}

const IDENTIFIER_PAGE_SIZE = 500;

const canonicalIdentity = (value: string): string =>
  value.trim().normalize('NFC').toLowerCase();

function readyModel(parsed: PeopleImportValidationResult): PeopleImportModel {
  if (parsed.model === null || parsed.errors.length > 0) {
    throw new PeopleImportNotReadyError();
  }
  return parsed.model;
}

function householdRow(household: PeopleImportHousehold): number {
  return Math.min(
    ...household.people.map((person) => person.row),
    ...household.dependents.map((dependent) => dependent.row),
  );
}

function firstPageSql(kind: IdentifierKind): string {
  switch (kind) {
    case 'email':
      return 'SELECT id, email AS identifier FROM people ORDER BY id LIMIT 500';
    case 'household_name':
      return 'SELECT id, name AS identifier FROM households WHERE deleted_at IS NULL ORDER BY id LIMIT 500';
  }
}

function nextPageSql(kind: IdentifierKind): string {
  switch (kind) {
    case 'email':
      return 'SELECT id, email AS identifier FROM people WHERE id > ? ORDER BY id LIMIT 500';
    case 'household_name':
      return 'SELECT id, name AS identifier FROM households WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT 500';
  }
}

async function existingIdentities(
  db: AppDb,
  kind: IdentifierKind,
  candidates: ImportedIdentifier[],
): Promise<Set<string>> {
  const remaining = new Set(candidates.map((candidate) => candidate.identity));
  const existing = new Set<string>();
  if (remaining.size === 0) return existing;

  // Do not use SQL LOWER for identity matching: D1 LOWER is ASCII-only, while
  // JavaScript NFC/lowercase can map Unicode identifiers (such as K) to ASCII.
  // Fixed id-keyset pages keep each response bounded while preserving parity.
  let cursor: number | null = null;
  while (remaining.size > 0) {
    const statement: AppStatement = cursor === null
      ? db.prepare(firstPageSql(kind))
      : db.prepare(nextPageSql(kind)).bind(cursor);
    const { results } = await statement.all<IdentifierRow>();
    for (const row of results) {
      const identity = canonicalIdentity(row.identifier);
      if (!remaining.delete(identity)) continue;
      existing.add(identity);
    }
    if (remaining.size === 0 || results.length < IDENTIFIER_PAGE_SIZE) break;
    cursor = results[results.length - 1].id;
  }

  return existing;
}

function compareIssues(left: PeopleImportDbIssue, right: PeopleImportDbIssue): number {
  const severity = (left.severity === 'error' ? 0 : 1) - (right.severity === 'error' ? 0 : 1);
  if (severity !== 0) return severity;
  const row = (left.row ?? Number.MAX_SAFE_INTEGER) - (right.row ?? Number.MAX_SAFE_INTEGER);
  if (row !== 0) return row;
  const field = (left.field ?? '').localeCompare(right.field ?? '');
  if (field !== 0) return field;
  return left.code.localeCompare(right.code);
}

function boundedResult(issues: PeopleImportDbIssue[]): PeopleImportPreflightResult {
  issues.sort(compareIssues);
  const bounded = issues.length > PEOPLE_IMPORT_LIMITS.maxIssues
    ? [
        ...issues.slice(0, PEOPLE_IMPORT_LIMITS.maxIssues - 1),
        {
          severity: 'error',
          code: 'issues_truncated',
          row: null,
          field: null,
        } satisfies PeopleImportDbIssue,
      ]
    : issues;
  return {
    errors: bounded.filter((issue) => issue.severity === 'error'),
    warnings: bounded.filter((issue) => issue.severity === 'warning'),
  };
}

export async function preflightPeopleImport(
  db: AppDb,
  parsed: PeopleImportValidationResult,
): Promise<PeopleImportPreflightResult> {
  const model = readyModel(parsed);
  if (model.people.length === 0 && model.households.length === 0) {
    return { errors: [], warnings: [] };
  }

  const emailCandidates = model.people.map((person) => ({
    identity: canonicalIdentity(person.email),
    row: person.row,
  }));
  const householdCandidates = model.households.map((household) => ({
    identity: canonicalIdentity(household.name),
    row: householdRow(household),
  }));
  const existingEmails = await existingIdentities(db, 'email', emailCandidates);
  const existingHouseholds = await existingIdentities(db, 'household_name', householdCandidates);

  const issues: PeopleImportDbIssue[] = [];
  for (const candidate of emailCandidates) {
    if (!existingEmails.has(candidate.identity)) continue;
    issues.push({ severity: 'error', code: 'email_exists', row: candidate.row, field: 'email' });
  }
  for (const candidate of householdCandidates) {
    if (!existingHouseholds.has(candidate.identity)) continue;
    issues.push({
      severity: 'warning',
      code: 'household_name_exists',
      row: candidate.row,
      field: 'household_name',
    });
  }
  return boundedResult(issues);
}

const PERSON_INSERT_SQL = `INSERT INTO people
  (first_name, last_name, display_name, email, phone, role, active, lang,
   birthday, address, membership_status, joined_on)
VALUES
  (?1, ?2, ?3, ?4, ?5, 'member', ?6, ?7, ?8, ?9, ?10, ?11)`;

const HOUSEHOLD_INSERT_SQL =
  'INSERT INTO households (name, address, phone) VALUES (?1, ?2, ?3)';

function assertNever(_value: never): never {
  throw new PeopleImportPersistenceError();
}

function householdIdentityExpression(backend: DbBackend): string {
  switch (backend) {
    case 'd1':
      return 'last_insert_rowid()';
    case 'supabase':
      return "currval(pg_get_serial_sequence('households','id'))";
    default:
      return assertNever(backend);
  }
}

function personInsert(db: AppDb, person: PeopleImportPerson): AppStatement {
  return db.prepare(PERSON_INSERT_SQL).bind(
    person.firstName ?? '',
    person.lastName ?? '',
    person.displayName,
    person.email,
    person.phone,
    person.active ? 1 : 0,
    person.language,
    person.birthday,
    person.address,
    person.membershipStatus,
    person.joinedOn,
  );
}

function householdRole(person: PeopleImportPerson): 'adult' | 'child' {
  if (person.household === null) {
    throw new PeopleImportPersistenceError();
  }
  return person.household.role;
}

function primaryMembershipInsert(
  db: AppDb,
  identityExpression: string,
  household: PeopleImportHousehold,
  primary: PeopleImportPerson,
): AppStatement {
  return db.prepare(`INSERT INTO household_members
  (household_id, person_id, display_name, role, is_primary)
VALUES (
  ${identityExpression},
  COALESCE((SELECT id FROM people WHERE email = ?1), -1),
  ?2, ?3, 1
)`).bind(
    household.primaryEmail,
    primary.displayName,
    householdRole(primary),
  );
}

const EXISTING_HOUSEHOLD_LOOKUP = `COALESCE((
    SELECT hm.household_id
    FROM people primary_person
    JOIN household_members hm
      ON hm.person_id = primary_person.id AND hm.is_primary = 1
    WHERE primary_person.email = ?1
  ), -1)`;

function personMembershipInsert(
  db: AppDb,
  household: PeopleImportHousehold,
  person: PeopleImportPerson,
): AppStatement {
  return db.prepare(`INSERT INTO household_members
  (household_id, person_id, display_name, role, is_primary)
VALUES (
  ${EXISTING_HOUSEHOLD_LOOKUP},
  COALESCE((SELECT id FROM people WHERE email = ?2), -1),
  ?3, ?4, 0
)`).bind(
    household.primaryEmail,
    person.email,
    person.displayName,
    householdRole(person),
  );
}

function dependentMembershipInsert(
  db: AppDb,
  household: PeopleImportHousehold,
  dependent: PeopleImportDependent,
): AppStatement {
  return db.prepare(`INSERT INTO household_members
  (household_id, person_id, display_name, role, is_primary)
VALUES (
  ${EXISTING_HOUSEHOLD_LOOKUP},
  NULL,
  ?2, ?3, 0
)`).bind(
    household.primaryEmail,
    dependent.displayName,
    dependent.household.role,
  );
}

function householdStatements(
  db: AppDb,
  identityExpression: string,
  household: PeopleImportHousehold,
): AppStatement[] {
  const primary = household.people.find((person) => person.email === household.primaryEmail);
  if (primary === undefined) {
    throw new PeopleImportPersistenceError();
  }

  const statements = [
    db.prepare(HOUSEHOLD_INSERT_SQL).bind(household.name, household.address, household.phone),
    primaryMembershipInsert(db, identityExpression, household, primary),
  ];
  const remaining = [
    ...household.people
      .filter((person) => person !== primary)
      .map((person) => ({ row: person.row, statement: personMembershipInsert(db, household, person) })),
    ...household.dependents
      .map((dependent) => ({ row: dependent.row, statement: dependentMembershipInsert(db, household, dependent) })),
  ].sort((left, right) => left.row - right.row);
  statements.push(...remaining.map(({ statement }) => statement));
  return statements;
}

export async function commitPeopleImport(
  db: AppDb,
  backend: DbBackend,
  parsed: PeopleImportValidationResult,
): Promise<PeopleImportCommitResult> {
  const model = readyModel(parsed);
  const result = {
    people: model.people.length,
    households: model.households.length,
    dependents: model.dependents.length,
  };
  if (model.people.length === 0 && model.households.length === 0) {
    return result;
  }

  try {
    const identityExpression = householdIdentityExpression(backend);
    const preflight = await preflightPeopleImport(db, parsed);
    if (preflight.errors.length > 0) {
      throw new PeopleImportConflictError();
    }

    const statements = [
      ...model.people.map((person) => personInsert(db, person)),
      ...model.households.flatMap((household) =>
        householdStatements(db, identityExpression, household)),
    ];
    await db.batch(statements);
  } catch (error) {
    if (
      error instanceof PeopleImportNotReadyError
      || error instanceof PeopleImportConflictError
      || error instanceof PeopleImportPersistenceError
    ) {
      throw error;
    }
    if (isUniqueViolation(error)) {
      throw new PeopleImportConflictError();
    }
    throw new PeopleImportPersistenceError();
  }
  return result;
}
