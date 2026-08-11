import type { AppDb, AppStatement } from './appDb';
import {
  PEOPLE_IMPORT_LIMITS,
  parsePeopleImport,
  type PeopleImportHeader,
  type PeopleImportHousehold,
  type PeopleImportModel,
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

export class PeopleImportNotReadyError extends Error {
  readonly code = 'import_not_ready' as const;

  constructor() {
    super('People import is not ready');
    this.name = 'PeopleImportNotReadyError';
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
