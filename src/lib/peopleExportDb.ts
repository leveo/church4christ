import { assertSnapshotBatchSupport, readSnapshotBatch, type AppDb } from './appDb';
import type { DbBackend } from './dbProvider';
import type {
  CanonicalPeopleExportDependent,
  CanonicalPeopleExportHouseholdReference,
  CanonicalPeopleExportPerson,
  CanonicalPeopleExportSource,
} from './peopleExport';
import type {
  PastoralNotesExportSource,
  PastoralNotesExportSourceNote,
} from './pastoralNotesExport';
import { MEMBERSHIP_STATUSES, type MembershipStatus } from './validate';

const EXPORT_SNAPSHOT_LIMIT = 5_001;

export const PEOPLE_EXPORT_SNAPSHOT_LIMITS = {
  maxCanonicalBytes: 8 * 1024 * 1024,
  maxNotesBytes: 10 * 1024 * 1024,
  maxRowsPerKind: 5_000,
} as const;

type DbRow = Record<string, unknown>;

const CANONICAL_PERSON_FIELDS = [
  'first_name',
  'last_name',
  'display_name',
  'email',
  'phone',
  'lang',
  'birthday',
  'address',
  'membership_status',
  'joined_on',
] as const;
const CANONICAL_PERSON_PROJECTED_FIELDS = CANONICAL_PERSON_FIELDS.filter(
  (field) => field !== 'lang' && field !== 'membership_status',
);
const CANONICAL_HOUSEHOLD_FIELDS = ['name', 'address', 'phone'] as const;
const CANONICAL_MEMBERSHIP_FIELDS = ['display_name'] as const;

function byteLengthSql(backend: DbBackend, expression: string): string {
  return backend === 'd1'
    ? `length(CAST(COALESCE(${expression}, '') AS BLOB))`
    : `octet_length(COALESCE(${expression}, ''))`;
}

function rowByteSumSql(
  backend: DbBackend,
  alias: string,
  fields: readonly string[],
): string {
  return fields.map((field) => byteLengthSql(backend, `${alias}.${field}`)).join(' + ');
}

function canonicalStatsCtesSql(backend: DbBackend): string {
  const peopleBytes = rowByteSumSql(backend, 'p', CANONICAL_PERSON_FIELDS);
  const householdBytes = rowByteSumSql(backend, 'h', CANONICAL_HOUSEHOLD_FIELDS);
  const membershipBytes = rowByteSumSql(backend, 'm', CANONICAL_MEMBERSHIP_FIELDS);
  return `
    export_people AS (
      SELECT p.id, p.first_name, p.last_name, p.display_name, p.email, p.phone,
             p.lang, p.birthday, p.address, p.membership_status, p.joined_on,
             p.active
      FROM people p
      WHERE p.deleted_at IS NULL
      ORDER BY p.id
      LIMIT 5001
    ),
    export_households AS (
      SELECT h.id, h.name, h.address, h.phone
      FROM households h
      WHERE h.deleted_at IS NULL
      ORDER BY h.id
      LIMIT 5001
    ),
    export_memberships AS (
      SELECT hm.id, hm.display_name
      FROM household_members hm
      LEFT JOIN households h ON h.id = hm.household_id
      LEFT JOIN people p ON p.id = hm.person_id
      WHERE (h.id IS NULL OR h.deleted_at IS NULL)
        AND (hm.person_id IS NULL OR p.id IS NULL OR p.deleted_at IS NULL)
      ORDER BY hm.id
      LIMIT 5001
    ),
    people_stats AS (
      SELECT COUNT(*) AS people_count,
             COALESCE(SUM(${peopleBytes}), 0) AS people_bytes
      FROM export_people p
    ),
    household_stats AS (
      SELECT COUNT(*) AS households_count,
             COALESCE(SUM(${householdBytes}), 0) AS household_bytes
      FROM export_households h
    ),
    membership_stats AS (
      SELECT COUNT(*) AS memberships_count,
             COALESCE(SUM(${membershipBytes}), 0) + COUNT(*) * 5 AS membership_bytes
      FROM export_memberships m
    ),
    export_stats AS (
      SELECT people_count, households_count, memberships_count,
             people_bytes + household_bytes + membership_bytes AS total_bytes
      FROM people_stats CROSS JOIN household_stats CROSS JOIN membership_stats
    )
  `;
}

function notesStatsCtesSql(backend: DbBackend): string {
  const notesBytes = rowByteSumSql(backend, 'n', ['author_email', 'body', 'created_at']);
  const emailBytes = byteLengthSql(backend, 'n.person_email');
  return `
    export_notes AS (
      SELECT n.id, n.person_id, n.author_email, n.body, n.created_at,
             p.email AS person_email
      FROM person_notes n
      JOIN people p ON p.id = n.person_id
      WHERE n.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY n.id
      LIMIT 5001
    ),
    export_stats AS (
      SELECT COUNT(*) AS notes_count,
             COALESCE(SUM(${notesBytes} + ${emailBytes}), 0) AS total_bytes
      FROM export_notes n
    )
  `;
}

const CANONICAL_GATE = `
  export_stats.total_bytes <= ?
  AND export_stats.people_count <= 5000
  AND export_stats.households_count <= 5000
  AND export_stats.memberships_count <= 5000
`;

const NOTES_GATE = `export_stats.total_bytes <= ? AND export_stats.notes_count <= 5000`;

function safeText(expression: string, alias: string, maxCharacters: number): string {
  return `CASE WHEN length(${expression}) <= ${maxCharacters} THEN ${expression} ELSE NULL END AS ${alias},
             CASE WHEN ${expression} IS NULL OR length(${expression}) <= ${maxCharacters} THEN 1 ELSE 0 END AS ${alias}_valid`;
}

interface CanonicalSnapshotStats {
  people_count: number;
  households_count: number;
  memberships_count: number;
  total_bytes: number;
}

interface NotesSnapshotStats {
  notes_count: number;
  total_bytes: number;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function canonicalStats(value: unknown): CanonicalSnapshotStats | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as DbRow;
  if (
    !nonnegativeInteger(row.people_count)
    || !nonnegativeInteger(row.households_count)
    || !nonnegativeInteger(row.memberships_count)
    || !nonnegativeInteger(row.total_bytes)
  ) return null;
  return {
    people_count: row.people_count,
    households_count: row.households_count,
    memberships_count: row.memberships_count,
    total_bytes: row.total_bytes,
  };
}

function notesStats(value: unknown): NotesSnapshotStats | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as DbRow;
  if (!nonnegativeInteger(row.notes_count) || !nonnegativeInteger(row.total_bytes)) return null;
  return { notes_count: row.notes_count, total_bytes: row.total_bytes };
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function zeroOrOne(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function membershipStatus(value: unknown): value is MembershipStatus {
  return (MEMBERSHIP_STATUSES as readonly unknown[]).includes(value);
}

function projectionsValid(row: DbRow, fields: readonly string[]): boolean {
  return fields.every((field) => row[`${field}_valid`] === 1);
}

interface SafePerson {
  id: number;
  export: Omit<CanonicalPeopleExportPerson, 'household'>;
}

interface SafeHousehold {
  id: number;
  stableKey: string;
  name: string;
  address: string | null;
  phone: string | null;
}

interface SafeMembership {
  id: number;
  householdId: number;
  personId: number | null;
  displayName: string;
  role: 'adult' | 'child';
  primary: boolean;
  householdExists: boolean;
  householdLive: boolean;
  personExists: boolean;
  personLive: boolean;
}

function safePerson(row: DbRow): SafePerson | null {
  if (
    !positiveInteger(row.id)
    || typeof row.first_name !== 'string'
    || typeof row.last_name !== 'string'
    || typeof row.display_name !== 'string'
    || typeof row.email !== 'string'
    || !nullableString(row.phone)
    || !zeroOrOne(row.active)
    || (row.lang !== null && row.lang !== 'en' && row.lang !== 'zh')
    || !nullableString(row.birthday)
    || !nullableString(row.address)
    || !membershipStatus(row.membership_status)
    || !nullableString(row.joined_on)
  ) return null;
  return {
    id: row.id,
    export: {
      stableKey: `person-${row.id}`,
      displayName: row.display_name,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      phone: row.phone,
      language: row.lang,
      membershipStatus: row.membership_status,
      birthday: row.birthday,
      joinedOn: row.joined_on,
      address: row.address,
      active: row.active === 1,
    },
  };
}

function safeHousehold(row: DbRow): SafeHousehold | null {
  if (
    !positiveInteger(row.id)
    || typeof row.name !== 'string'
    || !nullableString(row.address)
    || !nullableString(row.phone)
  ) return null;
  return {
    id: row.id,
    stableKey: `household-${row.id}`,
    name: row.name,
    address: row.address,
    phone: row.phone,
  };
}

function safeMembership(row: DbRow): SafeMembership | null {
  if (
    !positiveInteger(row.id)
    || !positiveInteger(row.household_id)
    || (row.person_id !== null && !positiveInteger(row.person_id))
    || typeof row.display_name !== 'string'
    || (row.role !== 'adult' && row.role !== 'child')
    || !zeroOrOne(row.is_primary)
    || !zeroOrOne(row.household_exists)
    || !zeroOrOne(row.household_live)
    || !zeroOrOne(row.person_exists)
    || !zeroOrOne(row.person_live)
  ) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    personId: row.person_id,
    displayName: row.display_name,
    role: row.role,
    primary: row.is_primary === 1,
    householdExists: row.household_exists === 1,
    householdLive: row.household_live === 1,
    personExists: row.person_exists === 1,
    personLive: row.person_live === 1,
  };
}

/** Read one cross-backend snapshot and convert internal IDs only to file-local-safe stable keys. */
export async function loadCanonicalPeopleExport(
  db: AppDb,
  today: string,
  backend: DbBackend,
): Promise<CanonicalPeopleExportSource> {
  assertSnapshotBatchSupport(db, backend);
  const statsCtes = canonicalStatsCtesSql(backend);
  const [statsResult, peopleResult, householdsResult, membershipsResult] = await readSnapshotBatch<DbRow>(db, backend, [
    db.prepare(`WITH ${statsCtes}
      SELECT people_count, households_count, memberships_count, total_bytes
      FROM export_stats
    `),
    db.prepare(`WITH ${statsCtes}
      SELECT p.id,
             ${safeText('p.first_name', 'first_name', 80)},
             ${safeText('p.last_name', 'last_name', 80)},
             ${safeText('p.display_name', 'display_name', 80)},
             ${safeText('p.email', 'email', 320)},
             ${safeText('p.phone', 'phone', 40)},
             p.active, p.lang,
             ${safeText('p.birthday', 'birthday', 10)},
             ${safeText('p.address', 'address', 200)},
             p.membership_status,
             ${safeText('p.joined_on', 'joined_on', 10)}
      FROM export_people p CROSS JOIN export_stats
      WHERE ${CANONICAL_GATE}
      ORDER BY p.id
      LIMIT 5001
    `).bind(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxCanonicalBytes),
    db.prepare(`WITH ${statsCtes}
      SELECT h.id,
             ${safeText('h.name', 'name', 80)},
             ${safeText('h.address', 'address', 200)},
             ${safeText('h.phone', 'phone', 40)}
      FROM export_households h CROSS JOIN export_stats
      WHERE ${CANONICAL_GATE}
      ORDER BY h.id
      LIMIT 5001
    `).bind(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxCanonicalBytes),
    db.prepare(`WITH ${statsCtes}
      SELECT hm.id, hm.household_id, hm.person_id,
             ${safeText('m.display_name', 'display_name', 80)},
             hm.role, hm.is_primary,
             CASE WHEN h.id IS NULL THEN 0 ELSE 1 END AS household_exists,
             CASE WHEN h.id IS NOT NULL AND h.deleted_at IS NULL THEN 1 ELSE 0 END AS household_live,
             CASE WHEN hm.person_id IS NULL OR p.id IS NOT NULL THEN 1 ELSE 0 END AS person_exists,
             CASE WHEN hm.person_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL) THEN 1 ELSE 0 END AS person_live
      FROM export_memberships m
      JOIN household_members hm ON hm.id = m.id
      LEFT JOIN households h ON h.id = hm.household_id
      LEFT JOIN people p ON p.id = hm.person_id
      CROSS JOIN export_stats
      WHERE ${CANONICAL_GATE}
      ORDER BY hm.id
      LIMIT 5001
    `).bind(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxCanonicalBytes),
  ]);

  const stats = canonicalStats(statsResult.results[0]);
  let integrityIssues = stats === null ? 1 : 0;
  if (stats !== null && (
    stats.people_count > PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxRowsPerKind
    || stats.households_count > PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxRowsPerKind
    || stats.memberships_count > PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxRowsPerKind
    || stats.total_bytes > PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxCanonicalBytes
  )) integrityIssues += 1;
  if (
    peopleResult.results.length >= EXPORT_SNAPSHOT_LIMIT
    || householdsResult.results.length >= EXPORT_SNAPSHOT_LIMIT
    || membershipsResult.results.length >= EXPORT_SNAPSHOT_LIMIT
  ) integrityIssues += 1;

  const peopleById = new Map<number, SafePerson>();
  for (const row of peopleResult.results) {
    const projectionIssue = !projectionsValid(row, CANONICAL_PERSON_PROJECTED_FIELDS);
    if (projectionIssue) integrityIssues += 1;
    const person = safePerson(row);
    if (!person) {
      if (!projectionIssue) integrityIssues += 1;
      continue;
    }
    if (peopleById.has(person.id)) {
      integrityIssues += 1;
      continue;
    }
    peopleById.set(person.id, person);
  }

  const householdsById = new Map<number, SafeHousehold>();
  for (const row of householdsResult.results) {
    const projectionIssue = !projectionsValid(row, CANONICAL_HOUSEHOLD_FIELDS);
    if (projectionIssue) integrityIssues += 1;
    const household = safeHousehold(row);
    if (!household) {
      if (!projectionIssue) integrityIssues += 1;
      continue;
    }
    if (householdsById.has(household.id)) {
      integrityIssues += 1;
      continue;
    }
    householdsById.set(household.id, household);
  }

  const membershipByPerson = new Map<number, SafeMembership>();
  const dependents: CanonicalPeopleExportDependent[] = [];
  const liveHouseholdsWithExportableMembership = new Set<number>();
  for (const row of membershipsResult.results) {
    const projectionIssue = !projectionsValid(row, CANONICAL_MEMBERSHIP_FIELDS);
    if (projectionIssue) integrityIssues += 1;
    const membership = safeMembership(row);
    if (!membership) {
      if (!projectionIssue) integrityIssues += 1;
      continue;
    }
    if (!membership.householdExists) {
      integrityIssues += 1;
      continue;
    }
    if (!membership.householdLive) {
      continue;
    }
    const household = householdsById.get(membership.householdId);
    if (!household) {
      integrityIssues += 1;
      continue;
    }
    if (membership.personId === null) {
      dependents.push({
        stableKey: `dependent-${membership.id}`,
        displayName: membership.displayName,
        household: {
          stableKey: household.stableKey,
          name: household.name,
          address: household.address,
          phone: household.phone,
          role: membership.role,
        },
      });
      liveHouseholdsWithExportableMembership.add(household.id);
      continue;
    }
    if (!membership.personExists) {
      integrityIssues += 1;
      continue;
    }
    if (!membership.personLive) continue;
    if (!peopleById.has(membership.personId)) {
      integrityIssues += 1;
      continue;
    }
    if (membershipByPerson.has(membership.personId)) {
      integrityIssues += 1;
      continue;
    }
    membershipByPerson.set(membership.personId, membership);
    liveHouseholdsWithExportableMembership.add(household.id);
  }

  for (const householdId of householdsById.keys()) {
    if (!liveHouseholdsWithExportableMembership.has(householdId)) integrityIssues += 1;
  }

  const people: CanonicalPeopleExportPerson[] = [];
  for (const person of peopleById.values()) {
    const membership = membershipByPerson.get(person.id);
    let household: CanonicalPeopleExportHouseholdReference | null = null;
    if (membership) {
      const source = householdsById.get(membership.householdId);
      if (!source) {
        integrityIssues += 1;
      } else {
        household = {
          stableKey: source.stableKey,
          name: source.name,
          address: source.address,
          phone: source.phone,
          role: membership.role,
          primary: membership.primary,
        };
      }
    }
    people.push({ ...person.export, household });
  }

  return {
    today,
    people,
    dependents,
    ...(integrityIssues > 0 ? { integrityIssues } : {}),
  };
}

function notesSourceRow(row: DbRow): { note: PastoralNotesExportSourceNote; valid: boolean } {
  const valid = projectionsValid(row, ['person_email', 'author_attribution', 'body', 'created_at'])
    && positiveInteger(row.note_id)
    && positiveInteger(row.person_id)
    && typeof row.person_email === 'string'
    && typeof row.author_attribution === 'string'
    && typeof row.body === 'string'
    && typeof row.created_at === 'string';
  return {
    note: {
      stableKey: positiveInteger(row.note_id) ? `note-${row.note_id}` : '',
      personStableKey: positiveInteger(row.person_id) ? `person-${row.person_id}` : '',
      personEmail: typeof row.person_email === 'string' ? row.person_email : '',
      authorAttribution: typeof row.author_attribution === 'string' ? row.author_attribution : '',
      body: typeof row.body === 'string' ? row.body : '',
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    },
    valid,
  };
}

/** Load only live notes for live subjects; the serializer owns final byte validation. */
export async function loadPastoralNotesExport(
  db: AppDb,
  backend: DbBackend,
): Promise<PastoralNotesExportSource> {
  assertSnapshotBatchSupport(db, backend);
  const statsCtes = notesStatsCtesSql(backend);
  const [statsResult, result] = await readSnapshotBatch<DbRow>(db, backend, [
    db.prepare(`WITH ${statsCtes}
      SELECT notes_count, total_bytes
      FROM export_stats
    `),
    db.prepare(`WITH ${statsCtes}
      SELECT n.id AS note_id, n.person_id,
             ${safeText('n.person_email', 'person_email', 320)},
             ${safeText('n.author_email', 'author_attribution', 320)},
             ${safeText('n.body', 'body', 4000)},
             ${safeText('n.created_at', 'created_at', 19)}
      FROM export_notes n
      CROSS JOIN export_stats
      WHERE ${NOTES_GATE}
      ORDER BY n.id
      LIMIT 5001
    `).bind(PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxNotesBytes),
  ]);
  const mapped = result.results.map(notesSourceRow);
  const stats = notesStats(statsResult.results[0]);
  let integrityIssues = mapped.filter((row) => !row.valid).length;
  if (stats === null) integrityIssues += 1;
  else if (
    stats.notes_count > PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxRowsPerKind
    || stats.total_bytes > PEOPLE_EXPORT_SNAPSHOT_LIMITS.maxNotesBytes
  ) integrityIssues += 1;
  return {
    notes: mapped.map((row) => row.note),
    ...(integrityIssues > 0 ? { integrityIssues } : {}),
  };
}
